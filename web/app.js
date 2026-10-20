import {
  STATUS, RUN, DEFAULT_SETTINGS, buildPromptText, newProjectState, counts, nextPendingIndex,
  applyFailure, recoverInterrupted, resetForRetry, buildManifest, buildFailedReport, projectFolderOf,
} from "./lib/queue.js";
import { pingExtension, diagnose, generateImage, extensionApiAvailable } from "./lib/bridge.js";
import { folderPickerSupported, pickRootFolder, forgetRootFolder, loadRootFolder, ensurePermission, ProjectWriter, dataUrlToBlob, verifyImageBlob } from "./lib/fs.js";
import { initComposer } from "./lib/composer.js";

const $ = (id) => document.getElementById(id);
const STATE_KEY = "bulkgen.state.v1";
const LOG_LIMIT = 300;
const DESKTOP = !!window.desktop;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- persistent state ----------

const state = loadState();
let rootHandle = null;
let loopActive = false;
let shownSummaryFor = null;
let extInfo = { installed: false };
let metaStatus = { loggedIn: null, ready: null };
let composer = null;
let itemTimes = []; // seconds per completed item, for the "about N min left" estimate

function loadState() {
  try {
    const raw = localStorage.getItem(STATE_KEY);
    const s = raw ? JSON.parse(raw) : {};
    return {
      project: s.project || null,
      settings: { ...DEFAULT_SETTINGS, ...(s.settings || {}) },
      run: s.run || { state: RUN.IDLE, currentIndex: -1, consecutiveFailures: 0, summary: null },
      log: s.log || [],
    };
  } catch {
    return { project: null, settings: { ...DEFAULT_SETTINGS }, run: { state: RUN.IDLE, currentIndex: -1, consecutiveFailures: 0, summary: null }, log: [] };
  }
}
function save() {
  try { localStorage.setItem(STATE_KEY, JSON.stringify(state)); } catch (exc) { toast(`Could not save progress: ${exc.message}`); }
  render();
}
function log(level, message) {
  state.log.push({ t: new Date().toISOString(), level, message });
  if (state.log.length > LOG_LIMIT) state.log.splice(0, state.log.length - LOG_LIMIT);
}
const isBusy = () => [RUN.RUNNING, RUN.PAUSING, RUN.STOPPING].includes(state.run.state);

// ---------- connection status (Meta AI) ----------

function renderConnection() {
  const pill = $("conn-pill");
  const text = $("conn-text");
  const login = $("btn-login");
  let cls = "pill pill-wait", label = "Checking…", showLogin = false;
  if (DESKTOP) {
    if (metaStatus.loggedIn && metaStatus.ready) { cls = "pill pill-on"; label = "Connected · Meta AI ready"; }
    else if (metaStatus.loggedIn) { cls = "pill pill-wait"; label = "Connected · loading Meta AI…"; }
    else if (metaStatus.loggedIn === false) { cls = "pill pill-off"; label = "Not connected"; showLogin = true; }
  } else if (!extInfo.installed) {
    cls = "pill pill-off"; label = "Helper not installed";
  } else if (metaStatus.loggedIn === false) {
    cls = "pill pill-off"; label = "Not logged in to Meta AI"; showLogin = true;
  } else if (metaStatus.loggedIn) {
    cls = "pill pill-on"; label = "Connected · Meta AI ready";
  } else {
    cls = "pill pill-wait"; label = "Helper ready · checking Meta AI…"; showLogin = true;
  }
  pill.className = cls;
  text.textContent = label;
  login.classList.toggle("hidden", !showLogin);
  $("footer-status").textContent = isBusy() ? "Meta AI: creating images" : label;
  if ($("login-dot")) $("login-dot").className = `dot ${metaStatus.loggedIn ? "ok" : metaStatus.loggedIn === false ? "bad" : ""}`;
}

async function checkExtension() {
  if (DESKTOP) {
    extInfo = await pingExtension();
    $("footer-version").textContent = `ImageRush ${extInfo.version || ""}`;
    renderConnection();
    return;
  }
  extInfo = extensionApiAvailable() ? await pingExtension() : { installed: false, error: "This browser cannot use the helper. Use Chrome, Brave or Edge." };
  $("ext-dot").className = `dot ${extInfo.installed ? "ok" : "bad"}`;
  $("ext-status").textContent = extInfo.installed ? `Helper found (version ${extInfo.version}).` : `Helper not found. ${extInfo.error || ""} Download it, add it to your browser, then press Re-check.`;
  renderConnection();
  if (extInfo.installed) checkMetaLogin();
}

async function checkMetaLogin() {
  try {
    const r = await diagnose();
    metaStatus = { loggedIn: !!r.loggedIn, ready: !!r.composerFound, url: r.url };
  } catch { metaStatus = { loggedIn: null, ready: null }; }
  renderConnection();
}

$("btn-login").addEventListener("click", async () => {
  if (DESKTOP) { await window.desktop.meta.login(); return; }
  window.open("https://www.meta.ai", "_blank", "noopener");
  toast("Log in on the meta.ai tab, then come back here.");
});
$("btn-ext-recheck")?.addEventListener("click", checkExtension);
$("btn-ext-help")?.addEventListener("click", () => $("ext-help").classList.toggle("hidden"));
$("btn-test")?.addEventListener("click", async () => { toast("Checking Meta AI…"); await checkMetaLogin(); toast(metaStatus.loggedIn ? "Connected to Meta AI." : "Meta AI is not logged in yet."); });

// ---------- output folder ----------

async function refreshFolderStatus() {
  if (DESKTOP) {
    const r = await window.desktop.fs.getRoot();
    rootHandle = { name: r.root, path: r.root };
    $("folder-path").textContent = r.root;
    render();
    return;
  }
  if (!folderPickerSupported()) {
    rootHandle = null;
    $("folder-path").textContent = "your Downloads folder";
    if ($("dir-status")) { $("dir-dot").className = "dot warn"; $("dir-status").textContent = "This browser cannot save into a chosen folder; images go to Downloads/ImageRush/<Project>/ instead. Chrome supports folders."; $("btn-choose-dir").disabled = true; }
    render();
    return;
  }
  const { handle, permission } = await loadRootFolder();
  rootHandle = handle;
  $("folder-path").textContent = handle ? handle.name : "your Downloads folder";
  if ($("dir-status")) {
    if (!handle) { $("dir-dot").className = "dot warn"; $("dir-status").textContent = "No folder chosen yet. Images go to Downloads/ImageRush/<Project>/ until you pick one."; }
    else if (permission === "granted") { $("dir-dot").className = "dot ok"; $("dir-status").textContent = `Saving into "${handle.name}" (one subfolder per project).`; }
    else { $("dir-dot").className = "dot warn"; $("dir-status").textContent = `Folder "${handle.name}" remembered. Click Change folder to allow access again.`; }
  }
  render();
}
async function chooseFolder() {
  try {
    if (DESKTOP) { const r = await window.desktop.fs.chooseRoot(); await refreshFolderStatus(); if (r.changed) toast(`Images will be saved into ${r.root}`); return; }
    if (!folderPickerSupported()) { toast("This browser cannot pick folders. Images will go to your Downloads folder."); return; }
    if (rootHandle && (await ensurePermission(rootHandle))) { await refreshFolderStatus(); toast(`Access to "${rootHandle.name}" granted.`); return; }
    rootHandle = await pickRootFolder();
    await refreshFolderStatus();
    toast(`Images will be saved into "${rootHandle.name}".`);
  } catch (exc) {
    if (exc.name !== "AbortError") toast(`Folder not chosen: ${exc.message}`);
  }
}
function openFolder() {
  if (DESKTOP) { window.desktop.fs.openFolder(state.project ? projectFolderOf(state.project) : ""); return; }
  toast(rootHandle ? `Your images are in "${rootHandle.name}".` : "Your images are in your Downloads folder, under ImageRush.");
}
$("btn-change-folder").addEventListener("click", chooseFolder);
$("btn-select-folder-top").addEventListener("click", chooseFolder);
$("btn-choose-dir")?.addEventListener("click", chooseFolder);
$("btn-forget-dir")?.addEventListener("click", async () => { await forgetRootFolder(); rootHandle = null; await refreshFolderStatus(); });
$("btn-open-folder").addEventListener("click", openFolder);
$("btn-success-open").addEventListener("click", openFolder);

// ---------- ideas -> project ----------

function loadProjectFromValidation(validation, sourceName) {
  if (state.project && isBusy()) { toast("Pause or stop the current batch first."); return false; }
  state.project = newProjectState(validation, sourceName);
  state.run = { state: RUN.IDLE, currentIndex: -1, consecutiveFailures: 0, summary: null };
  state.log = [];
  itemTimes = [];
  log("info", `Starting "${state.project.name}" with ${state.project.items.length} image(s).`);
  save();
  return true;
}

const isLocal = /^(localhost|127\.0\.0\.1)$/.test(location.hostname) || location.protocol === "file:";
composer = initComposer({
  root: $("composer"),
  aiEndpoint: DESKTOP ? "desktop" : isLocal ? "https://bulk-meta-ai-image-generator-web.vercel.app/api/prompts" : `${location.origin}/api/prompts`,
  toast,
  onDraftChanged: () => render(),
  onUse: (validation, sourceName) => {
    if (loadProjectFromValidation(validation, sourceName)) { composer.clear(); start(); return true; }
    return false;
  },
});

// ---------- the queue loop ----------

async function preflight() {
  if (!state.project) throw new Error("Add some ideas first.");
  if (nextPendingIndex(state.project.items) === -1) throw new Error("Everything in the list is already done.");
  if (!DESKTOP) {
    if (!extInfo.installed) await checkExtension();
    if (!extInfo.installed) throw new Error("The ImageRush helper is not installed in this browser (see the right panel).");
  }
  if (!DESKTOP && rootHandle && !(await ensurePermission(rootHandle))) throw new Error(`Access to folder "${rootHandle.name}" was not granted.`);
  await refreshFolderStatus();
}

async function start() {
  try { await preflight(); } catch (exc) { toast(exc.message); return; }
  state.run.state = RUN.RUNNING;
  state.run.consecutiveFailures = 0;
  state.run.startedAt = state.run.startedAt || new Date().toISOString();
  state.run.summary = null;
  log("info", "Started.");
  save();
  runLoop();
}

async function runLoop() {
  if (loopActive) return;
  loopActive = true;
  const writer = new ProjectWriter(rootHandle, state.project);
  let reportsDue = 0;
  try {
    for (;;) {
      if (state.run.state === RUN.PAUSING) { state.run.state = RUN.PAUSED; log("info", "Paused."); save(); break; }
      if (state.run.state === RUN.STOPPING) { state.run.state = RUN.STOPPED; log("info", "Stopped. Remaining ideas were not sent."); save(); break; }
      if (state.run.state !== RUN.RUNNING) break;
      const index = nextPendingIndex(state.project.items);
      if (index === -1) {
        state.run.state = RUN.FINISHED;
        state.run.finishedAt = new Date().toISOString();
        state.run.summary = counts(state.project.items);
        state.run.currentIndex = -1;
        log("ok", `All done: ${state.run.summary.completed} ready, ${state.run.summary.failed} need another try, ${state.run.summary.skipped} skipped.`);
        await writeReports(writer);
        save();
        break;
      }
      const t0 = Date.now();
      const result = await processItem(index, writer);
      if (result.ok) itemTimes.push((Date.now() - t0) / 1000);
      reportsDue += 1;
      if (reportsDue >= 5 || !result.ok) { await writeReports(writer); reportsDue = 0; }
      save();
      if (result.loginRequired) { state.run.state = RUN.PAUSED; metaStatus = { loggedIn: false, ready: false }; log("warn", "Paused: please log in to Meta AI, then press Resume."); save(); break; }
      const limit = state.settings.pauseAfterConsecutiveFailures;
      if (limit > 0 && state.run.consecutiveFailures >= limit) {
        state.run.state = RUN.PAUSED; state.run.consecutiveFailures = 0;
        log("warn", `Paused after ${limit} problems in a row. Check Meta AI, then press Resume.`); save(); break;
      }
      if (state.run.state !== RUN.RUNNING) continue;
      const delayMs = (result.ok ? state.settings.delaySeconds : state.settings.retryBackoffSeconds) * 1000;
      if (delayMs > 0) { save(); await sleep(delayMs); }
    }
  } catch (exc) {
    state.run.state = RUN.PAUSED;
    log("error", `Unexpected problem, paused: ${exc.message}`);
    save();
  } finally {
    loopActive = false;
    state.run.currentIndex = -1;
    if (reportsDue > 0) await writeReports(writer).catch(() => {});
    save();
    if (state.run.state === RUN.RUNNING && nextPendingIndex(state.project.items) !== -1) runLoop();
  }
}

async function processItem(index, writer) {
  const item = state.project.items[index];
  const settings = state.settings;
  const promptText = buildPromptText(item, settings);
  Object.assign(item, { status: STATUS.GENERATING, attempts: item.attempts + 1, startedAt: new Date().toISOString(), promptSent: promptText, error: null, previewUrl: null });
  state.run.currentIndex = index;
  log("info", `Creating image ${index + 1} of ${state.project.items.length}: ${item.filename}`);
  save();
  try {
    const reply = await generateImage({ prompt: promptText, timeoutMs: settings.generationTimeoutSeconds * 1000, wantFormat: settings.outputFormat, allVariants: settings.saveAllVariants, newChat: settings.newChatPerPrompt });
    if (!reply.ok) throw Object.assign(new Error(friendlyError(reply.error)), { retryable: reply.retryable !== false, loginRequired: !!reply.loginRequired });
    if (!reply.images?.length) throw Object.assign(new Error("Meta AI did not return a picture."), { retryable: true });
    const saved = [];
    for (let v = 0; v < reply.images.length; v++) {
      const img = reply.images[v];
      if (img.note) log("warn", `${item.filename}: ${img.note}`);
      let blob;
      if (img.blob) blob = img.blob;
      else if (img.dataUrl) blob = dataUrlToBlob(img.dataUrl);
      else {
        const resp = await fetch(img.url).catch(() => null);
        if (!resp || !resp.ok) throw Object.assign(new Error("The picture could not be read from Meta's server."), { retryable: true });
        blob = await resp.blob();
      }
      const size = await verifyImageBlob(blob).catch(() => { throw Object.assign(new Error("Meta returned something that is not a picture."), { retryable: true }); });
      const base = v === 0 ? item.filename : `${item.filename}_v${v + 1}`;
      const out = await writer.saveImage(base, img.ext || "png", blob);
      saved.push({ ...out, ext: img.ext || "png", width: size.width, height: size.height, previewUrl: URL.createObjectURL(blob) });
    }
    if (settings.savePromptCopies) {
      try { await writer.savePromptCopy(saved[0].name.replace(/\.[^.]+$/, ""), item.prompt); } catch (exc) { log("warn", `Text copy not saved: ${exc.message}`); }
    }
    Object.assign(item, { status: STATUS.COMPLETED, outputPath: saved[0].path, format: saved[0].ext, width: saved[0].width, height: saved[0].height, size: saved[0].size, previewUrl: saved[0].previewUrl, completedAt: new Date().toISOString(), error: null, variants: saved.slice(1).map((x) => x.path) });
    state.run.consecutiveFailures = 0;
    log("ok", `Saved ${saved[0].name}`);
    return { ok: true };
  } catch (exc) {
    const message = exc?.message || String(exc);
    Object.assign(item, applyFailure(item, message, settings, { retryable: exc.retryable !== false }));
    state.run.consecutiveFailures += 1;
    log("error", `${item.filename}: ${message}${item.status === STATUS.PENDING ? " (will try again)" : ""}`);
    return { ok: false, loginRequired: !!exc.loginRequired };
  }
}

function friendlyError(msg) {
  if (!msg) return "Something went wrong.";
  if (/No image appeared/i.test(msg)) return "Meta AI took too long to answer";
  if (/not logged in/i.test(msg)) return "You are not logged in to Meta AI";
  if (/chat box/i.test(msg)) return "Could not find the Meta AI chat box";
  if (/declined/i.test(msg)) return "Meta AI declined this idea; try rewording it";
  if (/usage limit/i.test(msg)) return "Meta AI says you have hit a limit; wait a while";
  return msg;
}

async function writeReports(writer) {
  try {
    await writer.writeJson("generation_manifest.json", buildManifest(state.project, { outputRoot: writer.root ? writer.root.name : "Downloads" }, state.project.items));
    await writer.writeJson("failed_prompts.json", buildFailedReport(state.project, state.project.items));
  } catch (exc) {
    log("warn", `Could not write the summary file: ${exc.message}`);
  }
}

// ---------- controls ----------

function pause() {
  if (state.run.state !== RUN.RUNNING) return;
  state.run.state = loopActive && state.run.currentIndex >= 0 ? RUN.PAUSING : RUN.PAUSED;
  log("info", state.run.state === RUN.PAUSING ? "Pausing after the current image." : "Paused.");
  save();
}
function stop() {
  if (state.run.state === RUN.RUNNING || state.run.state === RUN.PAUSING) state.run.state = loopActive && state.run.currentIndex >= 0 ? RUN.STOPPING : RUN.STOPPED;
  else if (state.run.state === RUN.PAUSED) state.run.state = RUN.STOPPED;
  else return;
  log("info", state.run.state === RUN.STOPPING ? "Stopping after the current image." : "Stopped.");
  save();
}
function retryFailed() {
  let n = 0;
  state.project.items = state.project.items.map((it) => (it.status === STATUS.FAILED ? (n++, resetForRetry(it)) : it));
  log("info", `Trying ${n} image(s) again.`);
  save();
  if (!isBusy()) start();
}
function createMore() {
  if (isBusy()) return;
  state.project = null;
  state.run = { state: RUN.IDLE, currentIndex: -1, consecutiveFailures: 0, summary: null };
  shownSummaryFor = null;
  save();
  $("create-card").scrollIntoView({ behavior: "smooth", block: "start" });
}

$("btn-primary").addEventListener("click", () => {
  const rs = state.run.state;
  if (rs === RUN.RUNNING) return pause();
  const left = state.project ? nextPendingIndex(state.project.items) !== -1 : false;
  if ((rs === RUN.PAUSED || rs === RUN.STOPPED) && left) return start();
  if (composer.count > 0 && !isBusy()) {
    if (state.project) state.project = null; // the finished/stopped batch gives way to the new ideas
    return composer.use();
  }
  if (rs === RUN.FINISHED || rs === RUN.STOPPED) return createMore();
  toast("Add some ideas first.");
});
$("btn-stop").addEventListener("click", () => { if (confirm("Stop creating images? Pictures already saved stay in your folder.")) stop(); });
$("btn-success-retry").addEventListener("click", retryFailed);
$("btn-success-more").addEventListener("click", createMore);
$("btn-clear").addEventListener("click", () => {
  if (isBusy()) { toast("Stop the batch first."); return; }
  if (!confirm("Clear the list? Pictures already saved stay in your folder.")) return;
  state.project = null; state.run = { state: RUN.IDLE, currentIndex: -1, consecutiveFailures: 0, summary: null }; state.log = [];
  composer.clear();
  save();
});
$("filter-failed").addEventListener("change", render);
$("btn-activity").addEventListener("click", () => { const hidden = $("log").classList.toggle("hidden"); $("activity-chevron").textContent = hidden ? "▾" : "▴"; });
$("btn-export").addEventListener("click", async () => {
  if (!state.project) { toast("Nothing to export yet."); return; }
  const writer = new ProjectWriter(rootHandle, state.project);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  try {
    if (!DESKTOP && rootHandle && !(await ensurePermission(rootHandle))) throw new Error("folder access not granted");
    await writeReports(writer);
    await writer.writeJson(`report_${stamp}.json`, buildManifest(state.project, { outputRoot: writer.root ? writer.root.name : "Downloads" }, state.project.items), { overwrite: false });
    toast("Report saved next to your images.");
  } catch (exc) { toast(`Export failed: ${exc.message}`); }
});

// rows: edit draft / act on queue
$("queue-body").addEventListener("click", async (e) => {
  const row = e.target.closest(".row");
  if (!row) return;
  const i = Number(row.dataset.i);
  const act = e.target.closest("[data-act]")?.dataset.act;
  if (row.dataset.kind === "draft") {
    if (act === "remove") composer.remove(i);
    if (act === "rewrite") { const b = e.target.closest("[data-act]"); b.disabled = true; b.textContent = "…"; try { await composer.rewrite(i); } catch (exc) { toast(exc.message); render(); } }
    return;
  }
  const it = state.project?.items[i];
  if (!it) return;
  if (act === "retry") { state.project.items[i] = resetForRetry(it); log("info", `Trying ${it.filename} again.`); save(); if (!isBusy()) start(); }
  else if (act === "remove") { if (it.status === STATUS.PENDING || it.status === STATUS.FAILED) { it.status = STATUS.SKIPPED; it.completedAt = new Date().toISOString(); save(); } }
  else if (act === "unskip") { if (it.status === STATUS.SKIPPED) { it.status = STATUS.PENDING; it.completedAt = null; save(); } }
  else if (e.target.closest(".row-desc")) e.target.closest(".row-desc").classList.toggle("open");
});
$("queue-body").addEventListener("input", (e) => {
  const row = e.target.closest(".row[data-kind='draft']");
  if (!row) return;
  const i = Number(row.dataset.i);
  if (e.target.classList.contains("row-name-input")) composer.update(i, { filename: e.target.value });
  if (e.target.classList.contains("row-desc-input")) composer.update(i, { prompt: e.target.value });
  if (e.target.classList.contains("tag-select")) composer.update(i, { aspectRatio: e.target.value || null });
});

// settings
$("btn-settings").addEventListener("click", () => {
  const form = $("settings-form");
  for (const el of form.elements) { if (!el.name) continue; if (el.type === "checkbox") el.checked = !!state.settings[el.name]; else el.value = state.settings[el.name]; }
  $("settings-dialog").showModal();
});
$("btn-settings-cancel").addEventListener("click", () => $("settings-dialog").close());
$("settings-form").addEventListener("submit", (e) => {
  e.preventDefault();
  for (const el of e.target.elements) { if (!el.name) continue; state.settings[el.name] = el.type === "checkbox" ? el.checked : el.type === "number" ? Number(el.value) : el.value; }
  $("settings-dialog").close();
  save();
  toast("Settings saved.");
});

// ---------- rendering ----------

const shapeLabel = (ar) => ({ "16:9": "16:9 Landscape", "9:16": "9:16 Portrait", "1:1": "1:1 Square" }[ar] || (ar ? ar : "Any shape"));

function render() {
  const { project, run } = state;
  const c = project ? counts(project.items) : null;
  const showingQueue = !!project;
  const draftCount = composer ? composer.count : 0;

  const n = showingQueue ? c.total : draftCount;
  $("images-count").textContent = `${n} image${n === 1 ? "" : "s"}`;

  const done = c ? c.completed + c.failed + c.skipped : 0;
  const pct = c && c.total ? Math.round((done / c.total) * 100) : 0;
  $("progress-bar").style.width = `${pct}%`;
  $("progress-pct").textContent = `${pct}%`;
  const avg = itemTimes.length ? itemTimes.reduce((a, b) => a + b, 0) / itemTimes.length + state.settings.delaySeconds : 0;
  const left = c ? c.pending + c.generating : 0;
  const eta = avg && left ? ` · about ${Math.max(1, Math.round((avg * left) / 60))} min left` : "";
  const plural = (k, w) => `${k} ${w}${k === 1 ? "" : "s"}`;
  let ptext = "Ready to begin";
  let primary = "Create all images";
  let primaryDisabled = false;
  if (run.state === RUN.RUNNING) { ptext = `${c.completed} of ${c.total} done${eta}`; primary = "Pause"; }
  else if (run.state === RUN.PAUSING || run.state === RUN.STOPPING) { ptext = `${c.completed} of ${c.total} done · finishing the current image`; primary = "Please wait…"; primaryDisabled = true; }
  else if (run.state === RUN.PAUSED) { ptext = `Paused · ${c.completed} of ${c.total} done`; primary = left ? "Resume" : draftCount ? `Create ${plural(draftCount, "new image")}` : "Create more"; }
  else if (run.state === RUN.STOPPED) { ptext = `Stopped · ${c.completed} of ${c.total} done`; primary = left ? "Resume" : draftCount ? `Create ${plural(draftCount, "new image")}` : "Create more"; }
  else if (run.state === RUN.FINISHED) { ptext = `All finished · ${plural(c.completed, "image")} saved`; primary = draftCount ? `Create ${plural(draftCount, "new image")}` : "Create more"; }
  else if (draftCount) { ptext = `${plural(draftCount, "idea")} ready`; primary = `Create all images (${draftCount})`; }
  else if (project && left) { ptext = `${left} waiting`; primary = "Create all images"; }
  else { primaryDisabled = true; }
  $("progress-text").textContent = ptext;
  $("btn-primary").textContent = primary;
  $("btn-primary").disabled = primaryDisabled;
  $("btn-stop").disabled = !(run.state === RUN.RUNNING || run.state === RUN.PAUSING || run.state === RUN.PAUSED);
  $("btn-clear").classList.toggle("hidden", isBusy());

  const finished = run.state === RUN.FINISHED && c;
  $("success-panel").classList.toggle("hidden", !finished);
  if (finished) {
    $("success-heading").textContent = c.failed ? `${c.completed} ready, ${c.failed} need another try` : `${c.completed} image${c.completed === 1 ? " is" : "s are"} ready`;
    const folder = rootHandle ? (rootHandle.path || rootHandle.name) : "Downloads";
    $("success-sub").textContent = `Saved to ${folder}${DESKTOP ? "\\" : "/"}${projectFolderOf(project)}.`;
    $("btn-success-retry").classList.toggle("hidden", !c.failed);
    $("btn-success-retry").textContent = `Try again (${c.failed})`;
    if (shownSummaryFor !== run.finishedAt) { shownSummaryFor = run.finishedAt; $("success-panel").scrollIntoView({ behavior: "smooth", block: "nearest" }); }
  }

  renderRows(showingQueue);
  renderLog(state.log);
  renderConnection();
}

function renderRows(showingQueue) {
  const body = $("queue-body");
  const onlyFailed = $("filter-failed").checked;
  if (!showingQueue) {
    const items = composer ? composer.items : [];
    if (!items.length) { body.innerHTML = `<div class="empty"><div>🖼️</div><h4>No images yet</h4><div>Type an idea above or paste a list to get started. Each idea becomes one picture.</div></div>`; return; }
    body.innerHTML = items.map((it, i) => `
      <div class="row" data-kind="draft" data-i="${i}">
        <div class="thumb"><svg class="ic" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="9" r="1.5"/><path d="M21 16l-5-5-8 8"/></svg></div>
        <div class="row-main">
          <div class="row-top"><input class="row-name-input" value="${esc(it.filename)}" title="File name" /><span class="status pending">Ready</span></div>
          <textarea class="row-desc-input" rows="2" placeholder="Describe this picture…">${esc(it.prompt)}</textarea>
          <div class="row-meta"><select class="tag-select" title="Picture shape"><option value="" ${!it.aspectRatio ? "selected" : ""}>Any shape</option>${["16:9", "9:16", "1:1", "4:3", "3:4"].map((a) => `<option value="${a}" ${it.aspectRatio === a ? "selected" : ""}>${shapeLabel(a)}</option>`).join("")}</select></div>
        </div>
        <div class="row-actions">${composer.aiAvailable ? `<button class="btn small ghost" data-act="rewrite">Improve</button>` : ""}<button class="remove" data-act="remove" title="Remove">✕</button></div>
      </div>`).join("");
    return;
  }
  const { project, run } = state;
  const rows = [];
  project.items.forEach((it, i) => {
    if (onlyFailed && it.status !== STATUS.FAILED) return;
    const chip = {
      pending: `<span class="status pending">Waiting</span>`,
      generating: `<span class="status generating"><span class="spin"></span> Creating…</span>`,
      completed: `<span class="status completed">✓ Done</span>`,
      failed: `<span class="status failed">⚠ Needs retry</span>`,
      skipped: `<span class="status skipped">Skipped</span>`,
    }[it.status];
    const thumb = it.previewUrl?.startsWith("blob:") ? `<img src="${esc(it.previewUrl)}" alt="" />` : it.status === STATUS.GENERATING ? `<span class="spin"></span>` : it.status === STATUS.COMPLETED ? "✓" : it.status === STATUS.FAILED ? "⚠" : `<svg class="ic" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>`;
    const actions = [];
    if (it.status === STATUS.FAILED) actions.push(`<button class="btn small" data-act="retry">Try again</button>`);
    if (it.status === STATUS.COMPLETED && !isBusy()) actions.push(`<button class="btn small ghost" data-act="retry" title="Make this picture again">Redo</button>`);
    if (it.status === STATUS.SKIPPED) actions.push(`<button class="btn small ghost" data-act="unskip">Include</button>`);
    if (it.status === STATUS.PENDING || it.status === STATUS.FAILED) actions.push(`<button class="remove" data-act="remove" title="Skip this one">✕</button>`);
    const fileName = it.outputPath ? it.outputPath.split(/[\\/]/).pop() : `${it.filename}.${state.settings.outputFormat === "png" ? "png" : "jpg"}`;
    rows.push(`<div class="row ${i === run.currentIndex ? "active" : ""} ${it.status === STATUS.FAILED ? "failed" : ""}" data-kind="queue" data-i="${i}">
      <div class="thumb">${thumb}</div>
      <div class="row-main">
        <div class="row-top"><span class="row-name">${esc(fileName)}</span>${chip}</div>
        <div class="row-desc">${esc(it.prompt)}</div>
        <div class="row-meta"><span class="tag">${shapeLabel(it.aspectRatio)}</span>${it.size ? `<span>${(it.size / 1024 / 1024).toFixed(1)} MB</span>` : ""}${it.attempts > 1 ? `<span>${it.attempts} tries</span>` : ""}${it.error ? `<span class="err-text">${esc(it.error)}</span>` : ""}</div>
      </div>
      <div class="row-actions">${actions.join("")}</div>
    </div>`);
  });
  body.innerHTML = rows.join("") || `<div class="empty">Nothing to show.</div>`;
}

function renderLog(entries) {
  const el = $("log");
  const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 8;
  el.innerHTML = entries.slice(-150).map((e) => `<span class="${e.level}">[${e.t.slice(11, 19)}] ${esc(e.message)}</span>`).join("\n");
  if (atBottom) el.scrollTop = el.scrollHeight;
}

let toastTimer;
function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 4500);
}

// ---------- boot ----------

(async function boot() {
  if (DESKTOP) {
    $("web-aside").classList.add("hidden");
    window.desktop.meta.onStatus((s) => { metaStatus = { loggedIn: !!s.loggedIn, ready: !!s.ready }; renderConnection(); });
    window.desktop.panel.onChange((p) => { document.documentElement.style.setProperty("--panel", `${p.width}px`); });
    window.desktop.panel.get().then((p) => document.documentElement.style.setProperty("--panel", `${p.width}px`)).catch(() => {});
    window.desktop.meta.status().then((s) => { metaStatus = { loggedIn: !!s.loggedIn, ready: !!s.ready }; renderConnection(); }).catch(() => {});
    setInterval(() => window.desktop.meta.status().catch(() => {}), 5000);
  }
  if (state.project) {
    const interrupted = state.project.items.some((it) => it.status === STATUS.GENERATING);
    if (interrupted) { state.project.items = recoverInterrupted(state.project.items); log("warn", "Picked up an unfinished image after a restart; it will be tried again."); }
    if (isBusy()) { state.run.state = RUN.PAUSED; log("warn", "ImageRush was closed while running. Press Resume to continue."); }
    state.run.currentIndex = -1;
    for (const it of state.project.items) if (it.previewUrl && !it.previewUrl.startsWith("blob:")) it.previewUrl = null;
  }
  render();
  await Promise.all([checkExtension(), refreshFolderStatus()]);
})();
window.__bulkgen = { state, get rootHandle() { return rootHandle; }, composer: () => composer };
