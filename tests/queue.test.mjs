import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeFakeChrome, tinyPngDataUrl } from "./fake-chrome.mjs";
import { validatePromptFile } from "../extension/lib/validation.js";
import { buildPromptText, applyFailure, recoverInterrupted, nextPendingIndex, DEFAULT_SETTINGS } from "../extension/lib/queue.js";

const sampleText = readFileSync(new URL("../samples/test_prompts.json", import.meta.url), "utf-8");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let importCounter = 0;
async function boot({ generateImpl, downloadDir = mkdtempSync(join(tmpdir(), "bulkgen-")), storageSeed = null } = {}) {
  const chrome = makeFakeChrome({ downloadDir, generateImpl });
  if (storageSeed) Object.assign(chrome._storage, storageSeed);
  globalThis.chrome = chrome;
  // Fresh module instance each time (simulates the service worker starting up).
  await import(`../extension/background.js?v=${++importCounter}`);
  const call = (msg) => new Promise((resolve) => chrome.runtime.onMessage.fire(msg, {}, resolve));
  const state = () => chrome.storage.local.get(["project", "run", "settings", "log"]);
  const waitFor = async (pred, timeout = 30000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) { const s = await state(); if (pred(s)) return s; await sleep(10); }
    throw new Error("timed out waiting; last log: " + JSON.stringify((await state()).log?.slice(-3)));
  };
  return { chrome, call, state, waitFor, downloadDir };
}

function okImage() {
  return { ok: true, images: [{ url: "https://cdn.example/img.png", dataUrl: tinyPngDataUrl(), ext: "png", width: 1, height: 1 }] };
}

const fastSettings = { delaySeconds: 0, retryBackoffSeconds: 0, generationTimeoutSeconds: 20, savePromptCopies: true };

test("pure helpers: prompt text, failure policy, recovery", () => {
  const item = { prompt: "hello", aspectRatio: "16:9", attempts: 1 };
  assert.equal(buildPromptText(item, { ...DEFAULT_SETTINGS, includeAspectRatioInPrompt: false }), "hello");
  assert.equal(buildPromptText(item, DEFAULT_SETTINGS), "hello\n\nAspect ratio: 16:9");
  assert.equal(buildPromptText(item, { ...DEFAULT_SETTINGS, includeAspectRatioInPrompt: false, modifyPrompts: true, promptPrefix: "A ", promptSuffix: " Z" }), "A hello Z");
  assert.equal(applyFailure({ ...item, attempts: 1 }, "x", { maxRetries: 2 }).status, "pending");
  assert.equal(applyFailure({ ...item, attempts: 3 }, "x", { maxRetries: 2 }).status, "failed");
  assert.equal(applyFailure({ ...item, attempts: 1 }, "x", { maxRetries: 2 }, { retryable: false }).status, "failed");
  const rec = recoverInterrupted([{ status: "generating" }, { status: "completed" }]);
  assert.equal(rec[0].status, "pending");
  assert.equal(nextPendingIndex([{ status: "completed" }, { status: "pending" }]), 1);
});

test("three prompts run strictly one at a time, files and manifest are written", async () => {
  const calls = [];
  let active = 0;
  const { call, waitFor, downloadDir, chrome } = await boot({
    generateImpl: async (msg) => {
      active += 1;
      assert.equal(active, 1, "two generations overlapped");
      calls.push(msg.prompt);
      await sleep(30);
      active -= 1;
      return okImage();
    },
  });
  await call({ type: "update_settings", settings: fastSettings });
  const v = validatePromptFile(sampleText, "test_prompts.json");
  await call({ type: "load_project", validation: v, sourceName: "test_prompts.json" });
  const started = await call({ type: "start" });
  assert.equal(started.ok, true);
  const s = await waitFor((x) => x.run.state === "finished");
  assert.deepEqual(s.project.items.map((i) => i.status), ["completed", "completed", "completed"]);
  assert.equal(calls.length, 3);
  assert.ok(calls[0].startsWith(v.items[0].prompt));
  assert.ok(calls[0].endsWith("Aspect ratio: 16:9"));
  const folder = join(downloadDir, "Generated_Images", "Bible_Images");
  for (const name of ["creation_of_world.png", "noahs_ark.png", "moses_red_sea.png", "generation_manifest.json", "failed_prompts.json"]) {
    assert.ok(existsSync(join(folder, name)), `${name} missing`);
  }
  assert.ok(existsSync(join(folder, "prompts", "noahs_ark.txt")));
  assert.equal(readFileSync(join(folder, "prompts", "noahs_ark.txt"), "utf-8"), v.items[1].prompt);
  const png = readFileSync(join(folder, "creation_of_world.png"));
  assert.equal(png.subarray(1, 4).toString(), "PNG");
  const manifest = JSON.parse(readFileSync(join(folder, "generation_manifest.json"), "utf-8"));
  assert.equal(manifest.project, "Bible Images");
  assert.equal(manifest.totals.completed, 3);
  assert.equal(manifest.images[1].filename, "noahs_ark");
  assert.equal(manifest.images[1].prompt, v.items[1].prompt);
  assert.equal(manifest.images[1].status, "completed");
  assert.ok(manifest.images[1].output_path.endsWith("noahs_ark.png"));
  assert.ok(manifest.images[1].completed_at);
  assert.equal(manifest.images[1].error, null);
  assert.equal(JSON.parse(readFileSync(join(folder, "failed_prompts.json"), "utf-8")).count, 0);
  assert.equal(s.run.summary.completed, 3);
  // Starting again must not regenerate completed images.
  const again = await call({ type: "start" });
  assert.equal(again.ok, false);
  assert.match(again.error, /Nothing is pending/);
  assert.equal(chrome._tabs.length, 1, "exactly one meta.ai tab is used");
});

test("failed generations are retried, then reported; Retry Failed re-runs only failures", async () => {
  let noahCalls = 0;
  let mosesCalls = 0;
  const { call, waitFor, downloadDir } = await boot({
    generateImpl: async (msg) => {
      if (msg.prompt.includes("Noah")) { noahCalls += 1; if (noahCalls === 1) return { ok: false, retryable: true, error: "No image appeared within 20s." }; }
      if (msg.prompt.includes("Moses")) { mosesCalls += 1; if (mosesCalls === 1) return { ok: false, retryable: false, error: "Meta AI declined to generate this prompt." }; }
      return okImage();
    },
  });
  await call({ type: "update_settings", settings: { ...fastSettings, maxRetries: 1 } });
  await call({ type: "load_project", validation: validatePromptFile(sampleText, "t.json"), sourceName: "t.json" });
  await call({ type: "start" });
  let s = await waitFor((x) => x.run.state === "finished");
  assert.deepEqual(s.project.items.map((i) => i.status), ["completed", "completed", "failed"]);
  assert.equal(s.project.items[1].attempts, 2);
  assert.equal(s.project.items[2].error, "Meta AI declined to generate this prompt.");
  const folder = join(downloadDir, "Generated_Images", "Bible_Images");
  const failed = JSON.parse(readFileSync(join(folder, "failed_prompts.json"), "utf-8"));
  assert.equal(failed.count, 1);
  assert.equal(failed.failed[0].filename, "moses_red_sea");
  assert.ok(!existsSync(join(folder, "moses_red_sea.png")));

  const r = await call({ type: "retry_failed" });
  assert.equal(r.ok, true);
  s = await waitFor((x) => x.run.state === "finished" && x.project.items[2].status === "completed");
  assert.equal(mosesCalls, 2);
  assert.equal(noahCalls, 2, "completed items were not regenerated");
  assert.ok(existsSync(join(folder, "moses_red_sea.png")));
  assert.equal(JSON.parse(readFileSync(join(folder, "failed_prompts.json"), "utf-8")).count, 0);
});

test("a download that never lands on disk is treated as a failure, not a success", async () => {
  const { call, waitFor, chrome } = await boot({ generateImpl: async () => okImage() });
  await call({ type: "update_settings", settings: { ...fastSettings, maxRetries: 0, savePromptCopies: false } });
  const v = validatePromptFile(JSON.stringify({ project: "X", prompts: [{ filename: "only", prompt: "p" }] }));
  await call({ type: "load_project", validation: v, sourceName: "x.json" });
  chrome.downloads._failNext = true;
  await call({ type: "start" });
  const s = await waitFor((x) => x.run.state === "finished");
  assert.equal(s.project.items[0].status, "failed");
  assert.match(s.project.items[0].error, /interrupted/);
});

test("pause finishes the current image, resume continues, stop submits nothing more", async () => {
  const calls = [];
  const { call, waitFor } = await boot({ generateImpl: async (msg) => { calls.push(msg.prompt.slice(0, 30)); await sleep(80); return okImage(); } });
  await call({ type: "update_settings", settings: fastSettings });
  await call({ type: "load_project", validation: validatePromptFile(sampleText, "t.json"), sourceName: "t.json" });
  await call({ type: "start" });
  await waitFor((x) => x.project.items[0].status === "generating");
  const p = await call({ type: "pause" });
  assert.equal(p.run.state, "pausing");
  const s1 = await waitFor((x) => x.run.state === "paused");
  assert.equal(s1.project.items[0].status, "completed", "current image was finished before pausing");
  assert.equal(s1.project.items[1].status, "pending", "next prompt was not started");
  assert.equal(calls.length, 1);
  await sleep(150);
  assert.equal(calls.length, 1, "nothing ran while paused");

  await call({ type: "resume" });
  await waitFor((x) => x.project.items[1].status === "generating");
  const st = await call({ type: "stop" });
  assert.equal(st.run.state, "stopping");
  const s2 = await waitFor((x) => x.run.state === "stopped");
  assert.deepEqual(s2.project.items.map((i) => i.status), ["completed", "completed", "pending"]);
  await sleep(150);
  assert.equal(calls.length, 2, "no prompt submitted after stop");
  // Resume after stop picks up the remaining pending prompt.
  await call({ type: "resume" });
  const s3 = await waitFor((x) => x.run.state === "finished");
  assert.equal(s3.project.items[2].status, "completed");
  assert.equal(calls.length, 3);
});

test("skip, single retry (regenerate) and duplicate filenames get a numbered suffix", async () => {
  const { call, waitFor, downloadDir } = await boot({ generateImpl: async () => okImage() });
  await call({ type: "update_settings", settings: { ...fastSettings, savePromptCopies: false } });
  const v = validatePromptFile(JSON.stringify({ project: "Dup", prompts: [{ id: "a", filename: "same", prompt: "1" }, { id: "b", filename: "same", prompt: "2" }, { id: "c", filename: "third", prompt: "3" }] }));
  assert.ok(v.warnings.some((w) => w.includes('"same" is used by prompts #1, #2')));
  await call({ type: "load_project", validation: v, sourceName: "d.json" });
  await call({ type: "skip_item", index: 2 });
  await call({ type: "start" });
  let s = await waitFor((x) => x.run.state === "finished");
  assert.deepEqual(s.project.items.map((i) => i.status), ["completed", "completed", "skipped"]);
  const folder = join(downloadDir, "Generated_Images", "Dup");
  const files = readdirSync(folder).filter((f) => f.endsWith(".png")).sort();
  assert.deepEqual(files, ["same (1).png", "same.png"]);
  assert.ok(s.project.items[1].outputPath.endsWith("same (1).png"));
  // Regenerating keeps the old file and adds a new numbered one.
  await call({ type: "retry_item", index: 0 });
  s = await waitFor((x) => x.run.state === "finished" && x.project.items[0].attempts === 1 && x.project.items[0].status === "completed");
  assert.ok(existsSync(join(folder, "same (2).png")));
  assert.ok(existsSync(join(folder, "same.png")));
});

test("pauses after N consecutive failures and when login is required", async () => {
  const { call, waitFor } = await boot({ generateImpl: async () => ({ ok: false, retryable: true, error: "No image appeared within 20s." }) });
  await call({ type: "update_settings", settings: { ...fastSettings, maxRetries: 0, pauseAfterConsecutiveFailures: 2 } });
  await call({ type: "load_project", validation: validatePromptFile(sampleText, "t.json"), sourceName: "t.json" });
  await call({ type: "start" });
  const s = await waitFor((x) => x.run.state === "paused");
  assert.deepEqual(s.project.items.map((i) => i.status), ["failed", "failed", "pending"]);
  assert.ok(s.log.some((l) => l.message.includes("Paused after 2 failures")));

  const b2 = await boot({ generateImpl: async () => ({ ok: false, retryable: false, loginRequired: true, error: "You are not logged in to meta.ai." }) });
  await b2.call({ type: "update_settings", settings: { ...fastSettings, maxRetries: 0 } });
  await b2.call({ type: "load_project", validation: validatePromptFile(sampleText, "t.json"), sourceName: "t.json" });
  await b2.call({ type: "start" });
  const s2 = await b2.waitFor((x) => x.run.state === "paused");
  assert.equal(s2.project.items[0].status, "failed");
  assert.equal(s2.project.items[1].status, "pending");
  assert.ok(s2.log.some((l) => l.message.includes("log in to meta.ai")));
});

test("recovery after a restart: an interrupted image is retried and the batch completes", async () => {
  // First worker instance: run until item 2 is generating, then "crash" (drop the instance).
  const first = await boot({ generateImpl: async () => { await sleep(1000); return okImage(); } });
  await first.call({ type: "update_settings", settings: { ...fastSettings, savePromptCopies: false } });
  await first.call({ type: "load_project", validation: validatePromptFile(sampleText, "t.json"), sourceName: "t.json" });
  first.chrome.tabs.sendMessage = async (tabId, msg) => (msg.type === "generate" ? (await sleep(20), okImage()) : { ok: true });
  await first.call({ type: "start" });
  await first.waitFor((x) => x.project.items[0].status === "completed");
  // Freeze state as it would be mid-generation and hand the same storage to a new worker instance.
  const frozen = structuredClone(first.chrome._storage);
  first.chrome.tabs.sendMessage = () => new Promise(() => {}); // old instance hangs forever
  frozen.project.items[1].status = "generating";
  frozen.run.state = "running";
  frozen.run.currentIndex = 1;
  const second = await boot({ generateImpl: async () => okImage(), downloadDir: first.downloadDir, storageSeed: frozen });
  const s = await second.waitFor((x) => x.run.state === "finished");
  assert.deepEqual(s.project.items.map((i) => i.status), ["completed", "completed", "completed"]);
  assert.ok(s.log.some((l) => l.message.includes("Recovered an unfinished image")));
  const folder = join(first.downloadDir, "Generated_Images", "Bible_Images");
  assert.ok(existsSync(join(folder, "noahs_ark.png")));
  assert.ok(existsSync(join(folder, "moses_red_sea.png")));
  assert.ok(!existsSync(join(folder, "creation_of_world (1).png")), "completed image was not regenerated");
});
