// Additional QA cases: settings behaviour, timing, double-start, clear, export, formats, performance, security.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeFakeChrome, tinyPngDataUrl } from "./fake-chrome.mjs";
import { validatePromptFile } from "../extension/lib/validation.js";

const sampleText = readFileSync(new URL("../samples/test_prompts.json", import.meta.url), "utf-8");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let importCounter = 1000;

async function boot({ generateImpl, downloadDir = mkdtempSync(join(tmpdir(), "bulkgen-qa-")), storageSeed = null } = {}) {
  const chrome = makeFakeChrome({ downloadDir, generateImpl });
  if (storageSeed) Object.assign(chrome._storage, storageSeed);
  globalThis.chrome = chrome;
  await import(`../extension/background.js?qa=${++importCounter}`);
  const call = (msg) => new Promise((resolve) => chrome.runtime.onMessage.fire(msg, {}, resolve));
  const state = () => chrome.storage.local.get(["project", "run", "settings", "log"]);
  const waitFor = async (pred, timeout = 60000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) { const s = await state(); if (pred(s)) return s; await sleep(10); }
    throw new Error("timed out; last log: " + JSON.stringify((await state()).log?.slice(-3)));
  };
  return { chrome, call, state, waitFor, downloadDir };
}
const okImage = (ext = "png") => ({ ok: true, images: [{ url: `https://cdn.example/img.${ext}`, dataUrl: ext === "png" ? tinyPngDataUrl() : `data:image/${ext};base64,UklGRg==`, ext, width: 1, height: 1 }] });
const fast = { delaySeconds: 0, retryBackoffSeconds: 0, generationTimeoutSeconds: 20, savePromptCopies: false, newChatPerPrompt: false };
const oneItem = (filename = "only", prompt = "p") => validatePromptFile(JSON.stringify({ project: "QA", prompts: [{ filename, prompt }] }));

test("Q-03 prompt modification only applies when explicitly enabled", async () => {
  const seen = [];
  const { call, waitFor } = await boot({ generateImpl: async (m) => { seen.push(m.prompt); return okImage(); } });
  await call({ type: "update_settings", settings: { ...fast, includeAspectRatioInPrompt: false, promptPrefix: "PRE ", promptSuffix: " SUF", modifyPrompts: false } });
  await call({ type: "load_project", validation: oneItem("a", "exact text"), sourceName: "a.json" });
  await call({ type: "start" });
  await waitFor((s) => s.run.state === "finished");
  assert.equal(seen[0], "exact text");
  await call({ type: "update_settings", settings: { modifyPrompts: true } });
  await call({ type: "retry_item", index: 0 });
  await waitFor((s) => s.run.state === "finished" && seen.length === 2);
  assert.equal(seen[1], "PRE exact text SUF");
});

test("Q-15 delay between images is honoured", async () => {
  const times = [];
  const { call, waitFor } = await boot({ generateImpl: async () => { times.push(Date.now()); return okImage(); } });
  await call({ type: "update_settings", settings: { ...fast, delaySeconds: 1 } });
  await call({ type: "load_project", validation: validatePromptFile(sampleText, "t.json"), sourceName: "t.json" });
  await call({ type: "start" });
  await waitFor((s) => s.run.state === "finished");
  assert.equal(times.length, 3);
  assert.ok(times[1] - times[0] >= 1000, `gap1 ${times[1] - times[0]}`);
  assert.ok(times[2] - times[1] >= 1000, `gap2 ${times[2] - times[1]}`);
});

test("Q-17 repeated Start clicks run a single loop", async () => {
  let calls = 0;
  const { call, waitFor } = await boot({ generateImpl: async () => { calls++; await sleep(30); return okImage(); } });
  await call({ type: "update_settings", settings: fast });
  await call({ type: "load_project", validation: validatePromptFile(sampleText, "t.json"), sourceName: "t.json" });
  await Promise.all([call({ type: "start" }), call({ type: "start" }), call({ type: "resume" })]);
  await waitFor((s) => s.run.state === "finished");
  await sleep(100);
  assert.equal(calls, 3);
});

test("Q-18 clear project resets state and leaves files on disk", async () => {
  const { call, waitFor, downloadDir } = await boot({ generateImpl: async () => okImage() });
  await call({ type: "update_settings", settings: fast });
  await call({ type: "load_project", validation: oneItem(), sourceName: "a.json" });
  await call({ type: "start" });
  await waitFor((s) => s.run.state === "finished");
  const r = await call({ type: "clear_project" });
  assert.equal(r.project, null);
  assert.equal(r.run.state, "idle");
  assert.ok(existsSync(join(downloadDir, "Generated_Images", "QA", "only.png")));
  const s = await call({ type: "start" });
  assert.equal(s.ok, false);
  assert.match(s.error, /Load a JSON file first/);
});

test("Q-19 performance: 100 prompts finish with small per-item overhead", async () => {
  const { call, waitFor, chrome } = await boot({ generateImpl: async () => okImage() });
  await call({ type: "update_settings", settings: fast });
  const v = validatePromptFile(JSON.stringify({ project: "Big", prompts: Array.from({ length: 100 }, (_, i) => ({ id: i + 1, filename: `img_${String(i + 1).padStart(3, "0")}`, prompt: `prompt ${i + 1}` })) }));
  assert.equal(v.ok, true);
  await call({ type: "load_project", validation: v, sourceName: "big.json" });
  const t0 = Date.now();
  await call({ type: "start" });
  const s = await waitFor((x) => x.run.state === "finished", 120000);
  const elapsed = Date.now() - t0;
  assert.equal(s.run.summary.completed, 100);
  assert.ok(elapsed / 100 < 300, `per-item overhead ${elapsed / 100}ms`);
  assert.ok(JSON.stringify(chrome._storage).length < 400000, "stored state stays compact");
  assert.ok(s.log.length <= 300, "log is capped");
  const pngs = chrome._downloads.filter((d) => d.filename.endsWith(".png"));
  assert.equal(pngs.length, 100);
  assert.equal(new Set(pngs.map((d) => d.filename)).size, 100, "unique paths");
});

test("F-07 export report writes a timestamped copy of the manifest", async () => {
  const { call, waitFor, downloadDir } = await boot({ generateImpl: async () => okImage() });
  await call({ type: "update_settings", settings: fast });
  await call({ type: "load_project", validation: oneItem(), sourceName: "a.json" });
  await call({ type: "start" });
  await waitFor((s) => s.run.state === "finished");
  const r = await call({ type: "export_report" });
  assert.equal(r.ok, true);
  const files = readdirSync(join(downloadDir, "Generated_Images", "QA")).filter((f) => /^report_.*\.json$/.test(f));
  assert.equal(files.length, 1);
  const report = JSON.parse(readFileSync(join(downloadDir, "Generated_Images", "QA", files[0]), "utf-8"));
  assert.equal(report.totals.completed, 1);
});

test("F-09 original format is kept when the adapter returns webp; manifest records it", async () => {
  const { call, waitFor, downloadDir } = await boot({ generateImpl: async () => okImage("webp") });
  await call({ type: "update_settings", settings: { ...fast, outputFormat: "original" } });
  await call({ type: "load_project", validation: oneItem("pic"), sourceName: "a.json" });
  await call({ type: "start" });
  const s = await waitFor((x) => x.run.state === "finished");
  assert.ok(existsSync(join(downloadDir, "Generated_Images", "QA", "pic.webp")));
  assert.equal(s.project.items[0].format, "webp");
  const manifest = JSON.parse(readFileSync(join(downloadDir, "Generated_Images", "QA", "generation_manifest.json"), "utf-8"));
  assert.equal(manifest.images[0].format, "webp");
  assert.ok(manifest.images[0].output_path.endsWith("pic.webp"));
});

test("F-01b saveAllVariants writes _v2 files; adapter falling back to URL download still verified", async () => {
  const { call, waitFor, downloadDir } = await boot({ generateImpl: async () => ({ ok: true, images: [
    { url: "https://cdn.example/a.jpg", dataUrl: null, ext: "jpg", width: 10, height: 10 },
    { url: "https://cdn.example/b.jpg", dataUrl: null, ext: "jpg", width: 10, height: 10 },
  ] }) });
  await call({ type: "update_settings", settings: { ...fast, saveAllVariants: true } });
  await call({ type: "load_project", validation: oneItem("multi"), sourceName: "a.json" });
  await call({ type: "start" });
  const s = await waitFor((x) => x.run.state === "finished");
  assert.equal(s.project.items[0].status, "completed");
  assert.ok(existsSync(join(downloadDir, "Generated_Images", "QA", "multi.jpg")));
  assert.ok(existsSync(join(downloadDir, "Generated_Images", "QA", "multi_v2.jpg")));
  assert.deepEqual(s.project.items[0].variants.map((p) => p.split(/[\\/]/).pop()), ["multi_v2.jpg"]);
});

test("Q-08 unskip returns an item to pending and it is then processed", async () => {
  const { call, waitFor } = await boot({ generateImpl: async () => okImage() });
  await call({ type: "update_settings", settings: fast });
  await call({ type: "load_project", validation: validatePromptFile(sampleText, "t.json"), sourceName: "t.json" });
  await call({ type: "skip_item", index: 0 });
  let r = await call({ type: "unskip_item", index: 0 });
  assert.equal(r.project.items[0].status, "pending");
  await call({ type: "skip_item", index: 1 });
  await call({ type: "start" });
  const s = await waitFor((x) => x.run.state === "finished");
  assert.deepEqual(s.project.items.map((i) => i.status), ["completed", "skipped", "completed"]);
  r = await call({ type: "skip_item", index: 0 }); // completed items cannot be skipped
  assert.equal(r.project.items[0].status, "completed");
});

test("SEC-04 prompts with quotes, unicode and HTML produce valid JSON reports and exact prompt copies", async () => {
  const nasty = `He said "hi" \\ <img src=x onerror=alert(1)> — नमस्ते 🙂\nline2`;
  const { call, waitFor, downloadDir } = await boot({ generateImpl: async () => okImage() });
  await call({ type: "update_settings", settings: { ...fast, savePromptCopies: true } });
  await call({ type: "load_project", validation: oneItem("nasty", nasty), sourceName: "a.json" });
  await call({ type: "start" });
  await waitFor((x) => x.run.state === "finished");
  const folder = join(downloadDir, "Generated_Images", "QA");
  const manifest = JSON.parse(readFileSync(join(folder, "generation_manifest.json"), "utf-8"));
  assert.equal(manifest.images[0].prompt, nasty);
  assert.equal(readFileSync(join(folder, "prompts", "nasty.txt"), "utf-8"), nasty);
});

test("Q-06b unexpected adapter exception marks the item for retry rather than crashing the loop", async () => {
  let n = 0;
  const { call, waitFor } = await boot({ generateImpl: async () => { n++; if (n === 1) throw new Error("boom"); return okImage(); } });
  await call({ type: "update_settings", settings: { ...fast, maxRetries: 1 } });
  await call({ type: "load_project", validation: oneItem(), sourceName: "a.json" });
  await call({ type: "start" });
  const s = await waitFor((x) => x.run.state === "finished");
  assert.equal(s.project.items[0].status, "completed");
  assert.equal(s.project.items[0].attempts, 2);
});

test("Q-09b pause while idle-waiting between items takes effect before the next prompt", async () => {
  const seen = [];
  const { call, waitFor } = await boot({ generateImpl: async (m) => { seen.push(m.prompt); return okImage(); } });
  await call({ type: "update_settings", settings: { ...fast, delaySeconds: 1 } });
  await call({ type: "load_project", validation: validatePromptFile(sampleText, "t.json"), sourceName: "t.json" });
  await call({ type: "start" });
  await waitFor((s) => s.project.items[0].status === "completed");
  await call({ type: "pause" });
  const s = await waitFor((x) => x.run.state === "paused", 5000);
  assert.equal(seen.length, 1);
  assert.equal(s.project.items[1].status, "pending");
});
