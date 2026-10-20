// Service worker: owns the persistent queue, drives the meta.ai tab one prompt at a time,
// saves every image through chrome.downloads and keeps the manifest files up to date.
import {
  STATUS, RUN, DEFAULT_SETTINGS, buildPromptText, newProjectState, counts, nextPendingIndex,
  applyFailure, recoverInterrupted, resetForRetry, buildManifest, buildFailedReport, projectFolderOf,
} from "./lib/queue.js";

// Bind to the extension API object once so a reloaded worker never talks to a stale instance (also makes testing easier).
const chrome = globalThis.chrome;

const META_HOME = "https://www.meta.ai/";
const META_MATCH = /^https:\/\/(www\.)?meta\.ai\//;
const LOG_LIMIT = 300;
const WATCHDOG_ALARM = "bulkgen-watchdog";

let loopActive = false; // true while runLoop() is executing in this worker instance
let stateCache = null;
let stateLock = Promise.resolve();

// ---------- state persistence ----------

async function loadState() {
  if (stateCache) return stateCache;
  const stored = await chrome.storage.local.get(["project", "settings", "run", "log"]);
  stateCache = {
    project: stored.project || null,
    settings: { ...DEFAULT_SETTINGS, ...(stored.settings || {}) },
    run: stored.run || { state: RUN.IDLE, currentIndex: -1, consecutiveFailures: 0, summary: null },
    log: stored.log || [],
  };
  return stateCache;
}

/** Serialised read-modify-write so concurrent messages never clobber each other. */
function mutate(fn) {
  const next = stateLock.then(async () => {
    const state = await loadState();
    const result = await fn(state);
    await chrome.storage.local.set({ project: state.project, settings: state.settings, run: state.run, log: state.log });
    return result;
  });
  stateLock = next.catch(() => {});
  return next;
}

function pushLog(state, level, message) {
  state.log.push({ t: new Date().toISOString(), level, message });
  if (state.log.length > LOG_LIMIT) state.log.splice(0, state.log.length - LOG_LIMIT);
}

async function log(level, message) {
  await mutate((s) => pushLog(s, level, message));
  broadcast();
}

function broadcast() {
  chrome.runtime.sendMessage({ type: "state_changed" }).catch(() => {});
}

function publicState(state) {
  return {
    project: state.project,
    settings: state.settings,
    run: state.run,
    log: state.log.slice(-120),
    counts: state.project ? counts(state.project.items) : null,
  };
}

// ---------- helpers ----------

function sleepWithKeepalive(ms) {
  // Extension API calls reset the service worker idle timer, so long waits ping storage periodically.
  return new Promise((resolve) => {
    const end = Date.now() + ms;
    const tick = () => {
      const left = end - Date.now();
      if (left <= 0) return resolve();
      chrome.storage.local.get("run").then(() => setTimeout(tick, Math.min(15000, left)));
    };
    tick();
  });
}

async function findMetaTab() {
  const tabs = await chrome.tabs.query({ url: ["https://www.meta.ai/*", "https://meta.ai/*"] });
  return tabs.find((t) => !t.discarded) || null;
}

function waitForTabLoad(tabId, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("The meta.ai page took too long to load."));
    }, timeoutMs);
    function listener(id, info) {
      if (id === tabId && info.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((t) => {
      if (t.status === "complete") listener(tabId, { status: "complete" });
    }).catch(reject);
  });
}

async function ensureContentScript(tabId) {
  try {
    const pong = await chrome.tabs.sendMessage(tabId, { type: "ping" });
    if (pong && pong.ok) return;
  } catch {
    // not injected yet (tab was open before the extension was installed/reloaded)
  }
  await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  await sleepWithKeepalive(150);
  const pong = await chrome.tabs.sendMessage(tabId, { type: "ping" });
  if (!pong || !pong.ok) throw new Error("Could not connect to the meta.ai page.");
}

/** Open (or reuse) a meta.ai tab, optionally starting a fresh chat, and make sure the adapter is loaded. */
async function prepareMetaTab(newChat) {
  let tab = await findMetaTab();
  if (!tab) {
    tab = await chrome.tabs.create({ url: META_HOME, active: true });
    await waitForTabLoad(tab.id);
    await ensureContentScript(tab.id);
    return tab.id;
  }
  if (!META_MATCH.test(tab.url || "")) {
    await chrome.tabs.update(tab.id, { url: META_HOME });
    await waitForTabLoad(tab.id);
    await ensureContentScript(tab.id);
    return tab.id;
  }
  await ensureContentScript(tab.id);
  if (newChat) {
    // Fast path: in-page "New chat" (no reload). Fall back to loading the home page.
    const r = await chrome.tabs.sendMessage(tab.id, { type: "new_chat" }).catch(() => null);
    if (!r || !r.ok) {
      await chrome.tabs.update(tab.id, { url: META_HOME });
      await waitForTabLoad(tab.id);
      await ensureContentScript(tab.id);
    }
  }
  return tab.id;
}

function downloadAndWait(options) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download(options, (downloadId) => {
      if (chrome.runtime.lastError || downloadId === undefined) {
        return reject(new Error(`Download failed to start: ${chrome.runtime.lastError?.message || "unknown error"}`));
      }
      const timer = setTimeout(() => {
        chrome.downloads.onChanged.removeListener(listener);
        reject(new Error("Saving the file timed out."));
      }, 120000);
      function listener(delta) {
        if (delta.id !== downloadId || !delta.state) return;
        if (delta.state.current === "complete") {
          clearTimeout(timer);
          chrome.downloads.onChanged.removeListener(listener);
          chrome.downloads.search({ id: downloadId }, (results) => resolve(results[0]));
        } else if (delta.state.current === "interrupted") {
          clearTimeout(timer);
          chrome.downloads.onChanged.removeListener(listener);
          chrome.downloads.search({ id: downloadId }, (results) => {
            reject(new Error(`Saving the file was interrupted (${results[0]?.error || "unknown reason"}).`));
          });
        }
      }
      chrome.downloads.onChanged.addListener(listener);
    });
  });
}

/** The content script cannot read cross-origin pixels; the worker can fetch the CDN (host permission) and convert. */
async function fetchImageForSaving(img, wantFormat) {
  if (img.dataUrl) return { url: img.dataUrl, ext: img.ext || "png" };
  try {
    const resp = await fetch(img.url, { credentials: "omit" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    let blob = await resp.blob();
    if (!blob.type.startsWith("image/")) throw new Error(`not an image (${blob.type || "unknown type"})`);
    let ext = blob.type.replace("image/", "").replace("jpeg", "jpg");
    if (wantFormat === "png" && blob.type !== "image/png" && typeof createImageBitmap === "function" && typeof OffscreenCanvas === "function") {
      const bitmap = await createImageBitmap(blob);
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      canvas.getContext("2d").drawImage(bitmap, 0, 0);
      blob = await canvas.convertToBlob({ type: "image/png" });
      ext = "png";
    }
    const buf = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    for (let i = 0; i < buf.length; i += 0x8000) binary += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return { url: `data:${blob.type};base64,${btoa(binary)}`, ext };
  } catch (exc) {
    // Last resort: let Chrome download the URL itself in whatever format the CDN serves.
    return { url: img.url, ext: img.ext || "jpg", note: `saved in original format (${exc.message})` };
  }
}

function jsonDataUrl(obj) {
  const text = JSON.stringify(obj, null, 2);
  return `data:application/json;charset=utf-8,${encodeURIComponent(text)}`;
}

function textDataUrl(text) {
  return `data:text/plain;charset=utf-8,${encodeURIComponent(text)}`;
}

function basename(path) {
  return path.split(/[\\/]/).pop();
}

async function writeReports(state) {
  if (!state.project) return;
  const folder = `${state.settings.outputRoot}/${projectFolderOf(state.project)}`;
  const manifest = buildManifest(state.project, state.settings, state.project.items);
  const failed = buildFailedReport(state.project, state.project.items);
  for (const [name, payload] of [["generation_manifest.json", manifest], ["failed_prompts.json", failed]]) {
    try {
      await downloadAndWait({ url: jsonDataUrl(payload), filename: `${folder}/${name}`, conflictAction: "overwrite", saveAs: false });
    } catch (exc) {
      pushLog(state, "warn", `Could not write ${name}: ${exc.message}`);
    }
  }
}

// ---------- one item ----------

async function processItem(index) {
  const state = await loadState();
  const settings = state.settings;
  const project = state.project;
  const item = project.items[index];
  const promptText = buildPromptText(item, settings);
  const folder = `${settings.outputRoot}/${projectFolderOf(project)}`;

  await mutate((s) => {
    const it = s.project.items[index];
    Object.assign(it, {
      status: STATUS.GENERATING, attempts: it.attempts + 1, startedAt: new Date().toISOString(),
      promptSent: promptText, error: null, previewUrl: null,
    });
    s.run.currentIndex = index;
    pushLog(s, "info", `Image ${index + 1} of ${s.project.items.length}: generating "${it.filename}" (attempt ${it.attempts}).`);
  });
  broadcast();

  try {
    const tabId = await prepareMetaTab(settings.newChatPerPrompt);
    const reply = await chrome.tabs.sendMessage(tabId, {
      type: "generate",
      prompt: promptText,
      timeoutMs: settings.generationTimeoutSeconds * 1000,
      wantFormat: settings.outputFormat,
      allVariants: settings.saveAllVariants,
    });
    if (!reply) throw Object.assign(new Error("No reply from the meta.ai page."), { retryable: true });
    if (!reply.ok) throw Object.assign(new Error(reply.error || "Generation failed."), { retryable: reply.retryable !== false, loginRequired: reply.loginRequired });
    if (!reply.images || !reply.images.length) throw Object.assign(new Error("No image was returned."), { retryable: true });

    const saved = [];
    for (let v = 0; v < reply.images.length; v++) {
      const img = reply.images[v];
      const prepared = await fetchImageForSaving(img, settings.outputFormat);
      if (prepared.note) await log("warn", `${item.filename}: ${prepared.note}`);
      const ext = prepared.ext;
      const base = v === 0 ? item.filename : `${item.filename}_v${v + 1}`;
      const result = await downloadAndWait({
        url: prepared.url,
        filename: `${folder}/${base}.${ext}`,
        conflictAction: "uniquify",
        saveAs: false,
      });
      // Verify the file really exists and is not empty before calling it done.
      if (!result || result.exists === false || !(result.fileSize > 0)) {
        throw Object.assign(new Error("The image file was not written to disk."), { retryable: true });
      }
      saved.push({ path: result.filename, ext, width: img.width, height: img.height, url: img.url });
    }

    if (settings.savePromptCopies) {
      const stem = basename(saved[0].path).replace(/\.[^.]+$/, "");
      try {
        await downloadAndWait({ url: textDataUrl(item.prompt), filename: `${folder}/prompts/${stem}.txt`, conflictAction: "uniquify", saveAs: false });
      } catch (exc) {
        await log("warn", `Prompt copy for ${item.filename} not saved: ${exc.message}`);
      }
    }

    await mutate((s) => {
      const it = s.project.items[index];
      Object.assign(it, {
        status: STATUS.COMPLETED, outputPath: saved[0].path, format: saved[0].ext, width: saved[0].width,
        height: saved[0].height, previewUrl: saved[0].url, completedAt: new Date().toISOString(), error: null,
        variants: saved.slice(1).map((x) => x.path),
      });
      s.run.consecutiveFailures = 0;
      pushLog(s, "ok", `Saved ${basename(saved[0].path)}${saved.length > 1 ? ` (+${saved.length - 1} variants)` : ""}.`);
    });
    return { ok: true };
  } catch (exc) {
    const message = exc?.message || String(exc);
    await mutate((s) => {
      const it = s.project.items[index];
      Object.assign(it, applyFailure(it, message, s.settings, { retryable: exc.retryable !== false }));
      s.run.consecutiveFailures += 1;
      if (exc.loginRequired) s.run.loginRequired = true;
      pushLog(s, "error", `${it.filename}: ${message}${it.status === STATUS.PENDING ? " (will retry)" : ""}`);
    });
    return { ok: false, loginRequired: !!exc.loginRequired, retrying: exc.retryable !== false };
  }
}

// ---------- the loop ----------

async function runLoop() {
  if (loopActive) return;
  loopActive = true;
  try {
    for (;;) {
      const state = await loadState();
      if (!state.project) break;
      if (state.run.state === RUN.PAUSING) { await mutate((s) => { s.run.state = RUN.PAUSED; pushLog(s, "info", "Paused."); }); break; }
      if (state.run.state === RUN.STOPPING) { await mutate((s) => { s.run.state = RUN.STOPPED; pushLog(s, "info", "Stopped. Remaining prompts were not submitted."); }); break; }
      if (state.run.state !== RUN.RUNNING) break;

      const index = nextPendingIndex(state.project.items);
      if (index === -1) {
        await mutate((s) => {
          s.run.state = RUN.FINISHED;
          s.run.finishedAt = new Date().toISOString();
          s.run.summary = counts(s.project.items);
          s.run.currentIndex = -1;
          pushLog(s, "ok", `Batch finished: ${s.run.summary.completed} completed, ${s.run.summary.failed} failed, ${s.run.summary.skipped} skipped.`);
        });
        await writeReports(await loadState());
        break;
      }

      const result = await processItem(index);
      await writeReports(await loadState());
      broadcast();

      const after = await loadState();
      if (result.loginRequired) {
        await mutate((s) => { s.run.state = RUN.PAUSED; pushLog(s, "warn", "Paused: please log in to meta.ai in the open tab, then press Resume."); });
        break;
      }
      const limit = after.settings.pauseAfterConsecutiveFailures;
      if (limit > 0 && after.run.consecutiveFailures >= limit) {
        await mutate((s) => { s.run.state = RUN.PAUSED; s.run.consecutiveFailures = 0; pushLog(s, "warn", `Paused after ${limit} failures in a row. Check the meta.ai tab, then press Resume.`); });
        break;
      }
      if (after.run.state !== RUN.RUNNING) continue; // pause/stop requested during the item: handled at loop top
      const delayMs = (result.ok ? after.settings.delaySeconds : after.settings.retryBackoffSeconds) * 1000;
      if (delayMs > 0) {
        await mutate((s) => pushLog(s, "info", `Waiting ${Math.round(delayMs / 1000)}s before the next prompt.`));
        broadcast();
        await sleepWithKeepalive(delayMs);
      }
    }
  } catch (exc) {
    await mutate((s) => { s.run.state = RUN.PAUSED; pushLog(s, "error", `Unexpected error, paused: ${exc?.message || exc}`); });
  } finally {
    loopActive = false;
    await mutate((s) => { s.run.currentIndex = -1; });
    broadcast();
    // A Start/Retry that arrived while this loop was wrapping up must not be lost.
    const after = await loadState();
    if (after.project && after.run.state === RUN.RUNNING && nextPendingIndex(after.project.items) !== -1) runLoop();
  }
}

async function resumeAfterRestart() {
  const state = await loadState();
  if (!state.project) return;
  const interrupted = state.project.items.some((it) => it.status === STATUS.GENERATING);
  if (interrupted) {
    await mutate((s) => {
      s.project.items = recoverInterrupted(s.project.items);
      pushLog(s, "warn", "Recovered an unfinished image after a restart; it will be retried.");
    });
  }
  if (state.run.state === RUN.RUNNING || state.run.state === RUN.PAUSING || state.run.state === RUN.STOPPING) {
    if (!loopActive) runLoop();
  }
}

// ---------- bridge for the hosted website (externally_connectable) ----------
// The website owns the queue and the output folder; it only asks this extension to run one prompt on meta.ai.
const externalHandlers = {
  async ping() { return { ok: true, version: chrome.runtime.getManifest().version }; },
  async diagnose() {
    const tabId = await prepareMetaTab(false);
    return chrome.tabs.sendMessage(tabId, { type: "diagnose" });
  },
  async generate({ prompt, timeoutMs = 180000, wantFormat = "png", allVariants = false, newChat = true }) {
    if (typeof prompt !== "string" || !prompt.trim()) throw new Error("Empty prompt.");
    const tabId = await prepareMetaTab(newChat);
    const reply = await chrome.tabs.sendMessage(tabId, { type: "generate", prompt, timeoutMs: Math.min(Math.max(timeoutMs, 20000), 1800000), wantFormat, allVariants });
    if (!reply) throw Object.assign(new Error("No reply from the meta.ai page."), { retryable: true });
    if (!reply.ok) return reply;
    const images = [];
    for (const img of reply.images) {
      const prepared = await fetchImageForSaving(img, wantFormat);
      images.push({ dataUrl: prepared.url.startsWith("data:") ? prepared.url : null, url: img.url, ext: prepared.ext, width: img.width, height: img.height, note: prepared.note || null });
    }
    return { ok: true, images };
  },
};

externalHandlers.save = async ({ filename, dataUrl, overwrite = false }) => {
  if (typeof filename !== "string" || !/^[^<>:"|?*\\/]+(\/[^<>:"|?*\\/]+)*$/.test(filename) || filename.includes("..")) throw new Error("Invalid file name.");
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:")) throw new Error("Invalid file data.");
  const result = await downloadAndWait({ url: dataUrl, filename, conflictAction: overwrite ? "overwrite" : "uniquify", saveAs: false });
  if (!result || result.exists === false || !(result.fileSize > 0)) throw new Error("The file was not written to disk.");
  return { ok: true, path: result.filename, size: result.fileSize };
};


// ---------- messages from the dashboard ----------

const handlers = {
  async get_state() { return publicState(await loadState()); },

  async load_project({ validation, sourceName }) {
    await mutate((s) => {
      s.project = newProjectState(validation, sourceName);
      s.run = { state: RUN.IDLE, currentIndex: -1, consecutiveFailures: 0, summary: null };
      s.log = [];
      pushLog(s, "info", `Loaded "${s.project.name}" with ${s.project.items.length} prompts from ${sourceName}.`);
    });
    return publicState(await loadState());
  },

  async clear_project() {
    await mutate((s) => { s.project = null; s.run = { state: RUN.IDLE, currentIndex: -1, consecutiveFailures: 0, summary: null }; s.log = []; });
    return publicState(await loadState());
  },

  async update_settings({ settings }) {
    await mutate((s) => { s.settings = { ...s.settings, ...settings }; });
    return publicState(await loadState());
  },

  async start() {
    const state = await loadState();
    if (!state.project) throw new Error("Load a JSON file first.");
    if (nextPendingIndex(state.project.items) === -1) throw new Error("Nothing is pending. Use Retry Failed or Regenerate to run images again.");
    await mutate((s) => { s.run.state = RUN.RUNNING; s.run.consecutiveFailures = 0; s.run.loginRequired = false; s.run.startedAt = s.run.startedAt || new Date().toISOString(); s.run.summary = null; pushLog(s, "info", "Started."); });
    runLoop();
    return publicState(await loadState());
  },

  async pause() {
    await mutate((s) => { if (s.run.state === RUN.RUNNING) { s.run.state = loopActive && s.run.currentIndex >= 0 ? RUN.PAUSING : RUN.PAUSED; pushLog(s, "info", s.run.state === RUN.PAUSING ? "Pausing after the current image." : "Paused."); } });
    return publicState(await loadState());
  },

  async resume() {
    const state = await loadState();
    if (!state.project) throw new Error("Load a JSON file first.");
    await mutate((s) => { s.run.state = RUN.RUNNING; s.run.consecutiveFailures = 0; s.run.loginRequired = false; pushLog(s, "info", "Resumed."); });
    runLoop();
    return publicState(await loadState());
  },

  async stop() {
    await mutate((s) => {
      if (s.run.state === RUN.RUNNING || s.run.state === RUN.PAUSING) {
        s.run.state = loopActive && s.run.currentIndex >= 0 ? RUN.STOPPING : RUN.STOPPED;
        pushLog(s, "info", s.run.state === RUN.STOPPING ? "Stopping after the current image." : "Stopped.");
      } else if (s.run.state === RUN.PAUSED) {
        s.run.state = RUN.STOPPED;
        pushLog(s, "info", "Stopped.");
      }
    });
    return publicState(await loadState());
  },

  async retry_item({ index }) {
    await mutate((s) => {
      const it = s.project.items[index];
      if (it && it.status !== STATUS.GENERATING) { s.project.items[index] = resetForRetry(it); pushLog(s, "info", `Queued ${it.filename} again.`); }
    });
    return handlers.start_if_idle();
  },

  async retry_failed() {
    await mutate((s) => {
      let n = 0;
      s.project.items = s.project.items.map((it) => (it.status === STATUS.FAILED ? (n++, resetForRetry(it)) : it));
      pushLog(s, "info", `Queued ${n} failed prompt(s) again.`);
    });
    return handlers.start_if_idle();
  },

  async skip_item({ index }) {
    await mutate((s) => {
      const it = s.project.items[index];
      if (it && (it.status === STATUS.PENDING || it.status === STATUS.FAILED)) { it.status = STATUS.SKIPPED; it.completedAt = new Date().toISOString(); pushLog(s, "info", `Skipped ${it.filename}.`); }
    });
    return publicState(await loadState());
  },

  async unskip_item({ index }) {
    await mutate((s) => {
      const it = s.project.items[index];
      if (it && it.status === STATUS.SKIPPED) { it.status = STATUS.PENDING; it.completedAt = null; }
    });
    return publicState(await loadState());
  },

  async start_if_idle() {
    const state = await loadState();
    if ([RUN.IDLE, RUN.FINISHED, RUN.STOPPED, RUN.PAUSED].includes(state.run.state) && nextPendingIndex(state.project.items) !== -1) {
      return handlers.start();
    }
    return publicState(state);
  },

  async export_report() {
    const state = await loadState();
    if (!state.project) throw new Error("Nothing to export.");
    await writeReports(state);
    const folder = `${state.settings.outputRoot}/${projectFolderOf(state.project)}`;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const report = buildManifest(state.project, state.settings, state.project.items);
    await downloadAndWait({ url: jsonDataUrl(report), filename: `${folder}/report_${stamp}.json`, conflictAction: "uniquify", saveAs: false });
    await log("ok", `Report exported to ${folder}/report_${stamp}.json`);
    return publicState(await loadState());
  },

  async open_folder() {
    const state = await loadState();
    const done = state.project?.items.find((it) => it.outputPath);
    if (done) {
      const results = await chrome.downloads.search({ filenameRegex: done.outputPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") });
      if (results[0]) { chrome.downloads.show(results[0].id); return { ok: true }; }
    }
    chrome.downloads.showDefaultFolder();
    return { ok: true };
  },

  async test_connection() {
    const tabId = await prepareMetaTab(false);
    const reply = await chrome.tabs.sendMessage(tabId, { type: "diagnose" });
    return reply;
  },

  async open_dashboard() { await openDashboard(); return { ok: true }; },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "keepalive") { sendResponse({ ok: true }); return false; }
  if (msg && msg.__fromSite) {
    // Relayed by site-bridge.js from the hosted website; only the website-facing handlers are reachable.
    const ext = externalHandlers[msg.type];
    if (!ext) { sendResponse({ ok: false, error: `Unknown request '${msg.type}'` }); return false; }
    ext(msg).then(sendResponse).catch((exc) => sendResponse({ ok: false, error: exc?.message || String(exc), retryable: exc?.retryable !== false, loginRequired: !!exc?.loginRequired }));
    return true;
  }
  const handler = handlers[msg?.type];
  if (!handler) return false;
  handler(msg).then((r) => sendResponse({ ok: true, ...r })).catch((exc) => sendResponse({ ok: false, error: exc?.message || String(exc) }));
  return true;
});

// Long-lived port from the content script keeps this worker alive during a slow generation.
chrome.runtime.onConnect.addListener((port) => {
  port.onMessage.addListener(() => {});
});

chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
  const handler = externalHandlers[msg?.type];
  if (!handler) { sendResponse({ ok: false, error: `Unknown request '${msg?.type}'` }); return false; }
  handler(msg).then(sendResponse).catch((exc) => sendResponse({ ok: false, error: exc?.message || String(exc), retryable: exc?.retryable !== false, loginRequired: !!exc?.loginRequired }));
  return true;
});

async function openDashboard() {
  // The extension has no UI of its own any more: the website is the dashboard.
  const url = "https://bulk-meta-ai-image-generator-web.vercel.app/";
  const tabs = await chrome.tabs.query({ url: `${url}*` });
  if (tabs[0]) {
    await chrome.tabs.update(tabs[0].id, { active: true });
    await chrome.windows.update(tabs[0].windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
}

chrome.action.onClicked.addListener(() => openDashboard());
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(WATCHDOG_ALARM, { periodInMinutes: 1 });
  resumeAfterRestart();
});
chrome.runtime.onStartup.addListener(() => resumeAfterRestart());
chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === WATCHDOG_ALARM) resumeAfterRestart(); });
try { chrome.downloads.setUiOptions?.({ enabled: false }).catch?.(() => {}); } catch { /* optional */ }
resumeAfterRestart();
