import { validatePromptFile } from "./lib/validation.js";
import { splitPrompts, textToPromptFile } from "./lib/parse-prompts.js";
import {
  STATUS, RUN, DEFAULT_SETTINGS, buildPromptText, newProjectState, counts, nextPendingIndex,
  applyFailure, recoverInterrupted, resetForRetry, buildManifest, buildFailedReport, projectFolderOf,
} from "./lib/queue.js";
import { pingExtension, diagnose, generateImage, extensionApiAvailable } from "./lib/bridge.js";
import { folderPickerSupported, pickRootFolder, forgetRootFolder, loadRootFolder, ensurePermission, ProjectWriter, dataUrlToBlob, verifyImageBlob, downloadBlob } from "./lib/fs.js";

const $ = (id) => document.getElementById(id);
const STATE_KEY = "bulkgen.state.v1";
const LOG_LIMIT = 300;

// ---------- persistent state ----------

const state = loadState();
let rootHandle = null;
let loopActive = false;
let pendingValidation = null;
let pendingSourceName = "";
let shownSummaryFor = null;
let extInfo = { installed: false };

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
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
  } catch (exc) {
    toast(`Could not save progress: ${exc.message}`);
  }
  render();
}

function log(level, message) {
  state.log.push({ t: new Date().toISOString(), level, message });
  if (state.log.length > LOG_LIMIT) state.log.splice(0, state.log.length - LOG_LIMIT);
}

// ---------- setup: extension + folder ----------

async function checkExtension() {
  if (!extensionApiAvailable()) {
    extInfo = { installed: false, error: "This browser cannot talk to extensions. Use Chrome, Brave or Edge." };
  } else {
    extInfo = await pingExtension();
  }
  $("ext-dot").className = `dot ${extInfo.installed ? "ok" : "bad"}`;
  $("ext-status").textContent = extInfo.installed
    ? `Extension found (version ${extInfo.version}).`
    : `Extension not found. ${extInfo.error || ""} Download it, load it in your browser, then press Re-check.`;
  render();
}

async function refreshFolderStatus() {
  if (!folderPickerSupported()) {
    $("dir-dot").className = "dot warn";
    $("dir-status").textContent = "This browser has folder access switched off (Brave: enable brave://flags/#file-system-access-api, or use Chrome). Images will be saved to Downloads/Generated_Images/<Project>/ through the extension instead.";
    $("btn-choose-dir").disabled = true;
    return;
  }
  const { handle, permission } = await loadRootFolder();
  rootHandle = handle;
  if (!handle) {
    $("dir-dot").className = "dot warn";
    $("dir-status").textContent = "No folder chosen. Images will go to Downloads/Generated_Images/<Project>/ through the extension. Choose a folder like Desktop to save there instead.";
  } else if (permission === "granted") {
    $("dir-dot").className = "dot ok";
    $("dir-status").textContent = `Saving into "${handle.name}" (one subfolder per project).`;
  } else {
    $("dir-dot").className = "dot warn";
    $("dir-status").textContent = `Folder "${handle.name}" remembered. Click "Choose folder" or Start to grant access again (browsers ask once per session).`;
  }
  render();
}

$("btn-choose-dir").addEventListener("click", async () => {
  try {
    if (rootHandle && (await ensurePermission(rootHandle))) { await refreshFolderStatus(); toast(`Access to "${rootHandle.name}" granted.`); return; }
    rootHandle = await pickRootFolder();
    await refreshFolderStatus();
    toast(`Images will be saved into "${rootHandle.name}".`);
  } catch (exc) {
    if (exc.name !== "AbortError") toast(`Folder not chosen: ${exc.message}`);
  }
});
$("btn-forget-dir").addEventListener("click", async () => { await forgetRootFolder(); rootHandle = null; await refreshFolderStatus(); });
$("btn-ext-recheck").addEventListener("click", checkExtension);
$("btn-ext-help").addEventListener("click", () => $("ext-help").classList.toggle("hidden"));
$("btn-test").addEventListener("click", async () => {
  toast("Checking the meta.ai tab…");
  try {
    const r = await diagnose();
    if (!r.ok) throw new Error(r.error || "unknown error");
    $("login-dot").className = `dot ${r.loggedIn ? "ok" : "bad"}`;
    alert(`meta.ai check\n\n${r.loggedIn ? "Logged in: yes" : "Logged in: NO — log in to meta.ai in the open tab"}\n${r.composerFound ? `Chat box found (${r.composerKind})` : "Chat box NOT found"}\n${r.sendButtonFound ? "Send button found" : "Send button not found (Enter key will be used)"}\n\nPage: ${r.url}`);
  } catch (exc) {
    alert(`Could not reach meta.ai through the extension: ${exc.message}`);
  }
});

// ---------- upload ----------

const dropzone = $("dropzone");
const fileInput = $("file-input");
$("btn-browse").addEventListener("click", () => fileInput.click());
dropzone.addEventListener("click", (e) => { if (e.target === dropzone || e.target.tagName === "P" || e.target.tagName === "STRONG") fileInput.click(); });
dropzone.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") fileInput.click(); });
["dragenter", "dragover"].forEach((ev) => dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add("drag"); }));
["dragleave", "drop"].forEach((ev) => dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove("drag"); }));
dropzone.addEventListener("drop", (e) => { const f = e.dataTransfer.files[0]; if (f) handleFile(f); });
fileInput.addEventListener("change", () => { const f = fileInput.files[0]; if (f) handleFile(f); fileInput.value = ""; });

async function handleFile(file) {
  $("btn-download-json").classList.add("hidden");
  generatedJsonText = null;
  if (!/\.json$/i.test(file.name) && file.type !== "application/json") return showValidation({ ok: false, errors: [`"${file.name}" is not a .json file.`], warnings: [] });
  if (file.size > 50 * 1024 * 1024) return showValidation({ ok: false, errors: ["The file is larger than 50 MB."], warnings: [] });
  const result = validatePromptFile(await file.text(), file.name);
  showValidation(result);
  if (result.ok) { pendingValidation = result; pendingSourceName = file.name; showPreview(result); } else hidePreview();
}

function showValidation(result) {
  const box = $("validation");
  box.classList.remove("hidden", "error", "warn", "ok");
  const list = (arr) => `<ul>${arr.map((m) => `<li>${esc(m)}</li>`).join("")}</ul>`;
  if (!result.ok) { box.classList.add("error"); box.innerHTML = `<strong>The file cannot be used.</strong>${list(result.errors)}`; }
  else if (result.warnings.length) { box.classList.add("warn"); box.innerHTML = `<strong>${result.items.length} prompt(s) found, with notes:</strong>${list(result.warnings)}`; }
  else { box.classList.add("ok"); box.innerHTML = `<strong>${result.items.length} prompt(s) found. The file looks good.</strong>`; }
}
function showPreview(result) {
  $("preview").classList.remove("hidden");
  $("preview-title").textContent = `Project "${result.projectName}" with ${result.items.length} prompt(s). Review, then confirm.`;
  $("preview-list").innerHTML = result.items.map((it) => `<li><code>${esc(String(it.promptId))}</code> <strong>${esc(it.filename)}</strong>${it.aspectRatio ? ` <span class="muted small">(${it.aspectRatio})</span>` : ""}<br><span class="muted">${esc(it.prompt)}</span></li>`).join("");
}
function hidePreview() {
  $("btn-download-json").classList.add("hidden");
  generatedJsonText = null; $("preview").classList.add("hidden"); pendingValidation = null; }
$("btn-cancel-preview").addEventListener("click", () => { hidePreview(); $("validation").classList.add("hidden"); });
$("btn-confirm-load").addEventListener("click", () => {
  if (!pendingValidation) return;
  if (state.project && isBusy()) return toast("Stop or pause the running batch before loading a new file.");
  if (state.project && !confirm(`Replace the current project "${state.project.name}"? Saved images stay on disk.`)) return;
  state.project = newProjectState(pendingValidation, pendingSourceName);
  state.run = { state: RUN.IDLE, currentIndex: -1, consecutiveFailures: 0, summary: null };
  state.log = [];
  log("info", `Loaded "${state.project.name}" with ${state.project.items.length} prompts from ${pendingSourceName}.`);
  hidePreview();
  $("validation").classList.add("hidden");
  save();
  toast("Prompts loaded. Press Start Generation when ready.");
});

// ---------- the queue loop ----------

const isBusy = () => [RUN.RUNNING, RUN.PAUSING, RUN.STOPPING].includes(state.run.state);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function preflight() {
  if (!state.project) throw new Error("Load a JSON file first.");
  if (nextPendingIndex(state.project.items) === -1) throw new Error("Nothing is pending. Use Retry Failed or Regenerate to run images again.");
  if (!extInfo.installed) await checkExtension();
  if (!extInfo.installed) throw new Error("The browser extension is not installed or not reachable (see step 1).");
  if (rootHandle && !(await ensurePermission(rootHandle))) throw new Error(`Access to folder "${rootHandle.name}" was not granted.`);
  await refreshFolderStatus();
}

async function start() {
  try { await preflight(); } catch (exc) { return toast(exc.message); }
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
  try {
    for (;;) {
      if (state.run.state === RUN.PAUSING) { state.run.state = RUN.PAUSED; log("info", "Paused."); save(); break; }
      if (state.run.state === RUN.STOPPING) { state.run.state = RUN.STOPPED; log("info", "Stopped. Remaining prompts were not submitted."); save(); break; }
      if (state.run.state !== RUN.RUNNING) break;
      const index = nextPendingIndex(state.project.items);
      if (index === -1) {
        state.run.state = RUN.FINISHED;
        state.run.finishedAt = new Date().toISOString();
        state.run.summary = counts(state.project.items);
        state.run.currentIndex = -1;
        log("ok", `Batch finished: ${state.run.summary.completed} completed, ${state.run.summary.failed} failed, ${state.run.summary.skipped} skipped.`);
        await writeReports(writer);
        save();
        break;
      }
      const result = await processItem(index, writer);
      await writeReports(writer);
      save();
      if (result.loginRequired) { state.run.state = RUN.PAUSED; log("warn", "Paused: log in to meta.ai in its tab, then press Resume."); save(); break; }
      const limit = state.settings.pauseAfterConsecutiveFailures;
      if (limit > 0 && state.run.consecutiveFailures >= limit) {
        state.run.state = RUN.PAUSED; state.run.consecutiveFailures = 0;
        log("warn", `Paused after ${limit} failures in a row. Check the meta.ai tab, then press Resume.`); save(); break;
      }
      if (state.run.state !== RUN.RUNNING) continue;
      const delayMs = (result.ok ? state.settings.delaySeconds : state.settings.retryBackoffSeconds) * 1000;
      if (delayMs > 0) { log("info", `Waiting ${Math.round(delayMs / 1000)}s before the next prompt.`); save(); await sleep(delayMs); }
    }
  } catch (exc) {
    state.run.state = RUN.PAUSED;
    log("error", `Unexpected error, paused: ${exc.message}`);
    save();
  } finally {
    loopActive = false;
    state.run.currentIndex = -1;
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
  log("info", `Image ${index + 1} of ${state.project.items.length}: generating "${item.filename}" (attempt ${item.attempts}).`);
  save();
  try {
    const reply = await generateImage({ prompt: promptText, timeoutMs: settings.generationTimeoutSeconds * 1000, wantFormat: settings.outputFormat, allVariants: settings.saveAllVariants, newChat: settings.newChatPerPrompt });
    if (!reply.ok) throw Object.assign(new Error(reply.error || "Generation failed."), { retryable: reply.retryable !== false, loginRequired: !!reply.loginRequired });
    if (!reply.images?.length) throw Object.assign(new Error("No image was returned."), { retryable: true });

    const saved = [];
    for (let v = 0; v < reply.images.length; v++) {
      const img = reply.images[v];
      if (img.note) log("warn", `${item.filename}: ${img.note}`);
      let blob;
      if (img.dataUrl) blob = dataUrlToBlob(img.dataUrl);
      else {
        const resp = await fetch(img.url).catch(() => null);
        if (!resp || !resp.ok) throw Object.assign(new Error("The image could not be read from Meta's server."), { retryable: true });
        blob = await resp.blob();
      }
      const size = await verifyImageBlob(blob).catch(() => { throw Object.assign(new Error("Meta returned data that is not a readable image."), { retryable: true }); });
      const base = v === 0 ? item.filename : `${item.filename}_v${v + 1}`;
      const out = await writer.saveImage(base, img.ext || "png", blob);
      saved.push({ ...out, ext: img.ext || "png", width: size.width, height: size.height, previewUrl: URL.createObjectURL(blob) });
    }
    if (settings.savePromptCopies) {
      try { await writer.savePromptCopy(saved[0].name.replace(/\.[^.]+$/, ""), item.prompt); } catch (exc) { log("warn", `Prompt copy not saved: ${exc.message}`); }
    }
    Object.assign(item, { status: STATUS.COMPLETED, outputPath: saved[0].path, format: saved[0].ext, width: saved[0].width, height: saved[0].height, previewUrl: saved[0].previewUrl, completedAt: new Date().toISOString(), error: null, variants: saved.slice(1).map((x) => x.path) });
    state.run.consecutiveFailures = 0;
    log("ok", `Saved ${saved[0].name}${saved.length > 1 ? ` (+${saved.length - 1} variants)` : ""}.`);
    return { ok: true };
  } catch (exc) {
    const message = exc?.message || String(exc);
    Object.assign(item, applyFailure(item, message, settings, { retryable: exc.retryable !== false }));
    state.run.consecutiveFailures += 1;
    log("error", `${item.filename}: ${message}${item.status === STATUS.PENDING ? " (will retry)" : ""}`);
    return { ok: false, loginRequired: !!exc.loginRequired };
  }
}

async function writeReports(writer) {
  try {
    await writer.writeJson("generation_manifest.json", buildManifest(state.project, { outputRoot: writer.root ? writer.root.name : "Downloads" }, state.project.items));
    await writer.writeJson("failed_prompts.json", buildFailedReport(state.project, state.project.items));
  } catch (exc) {
    log("warn", `Could not write the manifest: ${exc.message}`);
  }
}

// ---------- controls ----------

$("btn-start").addEventListener("click", start);
$("btn-resume").addEventListener("click", start);
$("btn-pause").addEventListener("click", () => {
  if (state.run.state !== RUN.RUNNING) return;
  state.run.state = loopActive && state.run.currentIndex >= 0 ? RUN.PAUSING : RUN.PAUSED;
  log("info", state.run.state === RUN.PAUSING ? "Pausing after the current image." : "Paused.");
  save();
});
$("btn-stop").addEventListener("click", () => {
  if (state.run.state === RUN.RUNNING || state.run.state === RUN.PAUSING) state.run.state = loopActive && state.run.currentIndex >= 0 ? RUN.STOPPING : RUN.STOPPED;
  else if (state.run.state === RUN.PAUSED) state.run.state = RUN.STOPPED;
  else return;
  log("info", state.run.state === RUN.STOPPING ? "Stopping after the current image." : "Stopped.");
  save();
});
$("btn-retry-failed").addEventListener("click", () => {
  let n = 0;
  state.project.items = state.project.items.map((it) => (it.status === STATUS.FAILED ? (n++, resetForRetry(it)) : it));
  log("info", `Queued ${n} failed prompt(s) again.`);
  save();
  if (!isBusy()) start();
});
$("btn-export").addEventListener("click", async () => {
  if (!state.project) return;
  const writer = new ProjectWriter(rootHandle, state.project);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  try {
    if (rootHandle && !(await ensurePermission(rootHandle))) throw new Error("folder access not granted");
    await writeReports(writer);
    const path = await writer.writeJson(`report_${stamp}.json`, buildManifest(state.project, { outputRoot: writer.root ? writer.root.name : "Downloads" }, state.project.items), { overwrite: false });
    log("ok", `Report exported to ${path}`);
    save();
    toast("Report exported.");
  } catch (exc) {
    toast(`Export failed: ${exc.message}`);
  }
});
$("btn-clear").addEventListener("click", () => {
  if (isBusy()) return toast("Stop the batch first.");
  if (!confirm("Clear the loaded project? Files already saved stay on disk.")) return;
  state.project = null;
  state.run = { state: RUN.IDLE, currentIndex: -1, consecutiveFailures: 0, summary: null };
  state.log = [];
  save();
});
$("btn-clear-log").addEventListener("click", () => $("log").classList.toggle("hidden"));
$("filter-failed").addEventListener("change", render);
$("queue-body").addEventListener("click", (e) => {
  const toggle = e.target.closest("[data-toggle]");
  if (toggle) return toggle.classList.toggle("open");
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const index = Number(btn.dataset.i);
  const it = state.project.items[index];
  const act = btn.dataset.act;
  if (act === "retry_item") {
    if (it.status === STATUS.COMPLETED && !confirm("Generate this image again? The existing file is kept and the new one gets a numbered suffix.")) return;
    state.project.items[index] = resetForRetry(it);
    log("info", `Queued ${it.filename} again.`);
    save();
    if (!isBusy()) start();
  } else if (act === "skip_item" && (it.status === STATUS.PENDING || it.status === STATUS.FAILED)) {
    it.status = STATUS.SKIPPED; it.completedAt = new Date().toISOString(); log("info", `Skipped ${it.filename}.`); save();
  } else if (act === "unskip_item" && it.status === STATUS.SKIPPED) {
    it.status = STATUS.PENDING; it.completedAt = null; save();
  }
});

// ---------- settings ----------

$("btn-settings").addEventListener("click", () => {
  const form = $("settings-form");
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === "checkbox") el.checked = !!state.settings[el.name];
    else el.value = state.settings[el.name];
  }
  $("settings-dialog").showModal();
});
$("btn-settings-cancel").addEventListener("click", () => $("settings-dialog").close());
$("settings-form").addEventListener("submit", (e) => {
  e.preventDefault();
  for (const el of e.target.elements) {
    if (!el.name) continue;
    state.settings[el.name] = el.type === "checkbox" ? el.checked : el.type === "number" ? Number(el.value) : el.value;
  }
  $("settings-dialog").close();
  save();
  toast("Settings saved.");
});
$("btn-summary-close").addEventListener("click", () => $("summary-dialog").close());

// ---------- rendering ----------

function render() {
  const { project, run, settings } = state;
  const c = project ? counts(project.items) : null;
  const badge = $("run-badge");
  badge.textContent = { idle: "Idle", running: "Running", pausing: "Pausing…", paused: "Paused", stopping: "Stopping…", stopped: "Stopped", finished: "Finished" }[run.state] || run.state;
  badge.className = `badge ${run.state}`;
  $("project-label").textContent = project ? `Loaded: ${project.sourceName}` : "";
  $("stat-project").textContent = project ? project.name : "—";
  $("stat-total").textContent = c ? c.total : 0;
  $("stat-completed").textContent = c ? c.completed : 0;
  $("stat-pending").textContent = c ? c.pending + c.generating : 0;
  $("stat-failed").textContent = c ? c.failed : 0;
  $("stat-skipped").textContent = c ? c.skipped : 0;
  const done = c ? c.completed + c.failed + c.skipped : 0;
  const pct = c && c.total ? Math.round((done / c.total) * 100) : 0;
  $("progress-bar").style.width = `${pct}%`;
  $("progress-text").textContent = project ? `${done} of ${c.total} processed (${pct}%)` : "No project loaded.";
  const folder = project ? `${rootHandle ? rootHandle.name : "Downloads/Generated_Images"}/${projectFolderOf(project)}/` : "";
  $("folder-hint").textContent = project ? `Images are saved to ${folder} along with generation_manifest.json and failed_prompts.json.` : "";

  const current = project && run.currentIndex >= 0 ? project.items[run.currentIndex] : null;
  $("current").classList.toggle("hidden", !current);
  if (current) {
    $("current-label").textContent = `Image ${run.currentIndex + 1} of ${project.items.length} — ${current.filename}`;
    $("current-prompt").textContent = current.promptSent || current.prompt;
    $("current-status").textContent = current.status === STATUS.GENERATING ? `Generating… (attempt ${current.attempts})` : current.status;
    $("current-preview").classList.add("hidden");
  }
  const hasPending = !!project && project.items.some((it) => it.status === STATUS.PENDING);
  $("btn-start").disabled = !project || !(run.state === RUN.IDLE || run.state === RUN.FINISHED || run.state === RUN.STOPPED) || !hasPending;
  $("btn-pause").disabled = run.state !== RUN.RUNNING;
  $("btn-resume").disabled = !(run.state === RUN.PAUSED || run.state === RUN.STOPPED) || !hasPending;
  $("btn-stop").disabled = !(run.state === RUN.RUNNING || run.state === RUN.PAUSING || run.state === RUN.PAUSED);
  $("btn-retry-failed").disabled = !c || !c.failed;
  $("btn-export").disabled = !project;
  $("btn-clear").disabled = !project;
  renderQueue(project, run);
  renderLog(state.log);
  if (run.state === RUN.FINISHED && run.finishedAt && shownSummaryFor !== run.finishedAt) { shownSummaryFor = run.finishedAt; showSummary(project, run, folder); }
}

function renderQueue(project, run) {
  const body = $("queue-body");
  if (!project) return (body.innerHTML = `<tr><td colspan="7" class="muted">Upload a JSON file to see the queue.</td></tr>`);
  const onlyFailed = $("filter-failed").checked;
  const rows = [];
  project.items.forEach((it, index) => {
    if (onlyFailed && it.status !== STATUS.FAILED) return;
    const actions = [];
    if (it.status === STATUS.FAILED) actions.push(`<button class="btn small" data-act="retry_item" data-i="${index}">Retry</button>`, `<button class="btn small ghost" data-act="skip_item" data-i="${index}">Skip</button>`);
    if (it.status === STATUS.COMPLETED) actions.push(`<button class="btn small" data-act="retry_item" data-i="${index}">Regenerate</button>`);
    if (it.status === STATUS.PENDING) actions.push(`<button class="btn small" data-act="skip_item" data-i="${index}">Skip</button>`);
    if (it.status === STATUS.SKIPPED) actions.push(`<button class="btn small" data-act="unskip_item" data-i="${index}">Unskip</button>`);
    const thumb = it.previewUrl && it.previewUrl.startsWith("blob:") ? `<img class="thumb" src="${esc(it.previewUrl)}" alt="" loading="lazy" />` : it.status === STATUS.COMPLETED ? `<span class="muted small">saved</span>` : "";
    rows.push(`<tr class="${index === run.currentIndex ? "active-row" : ""}">
      <td>${it.position}</td><td>${esc(String(it.promptId))}</td>
      <td><strong>${esc(it.filename)}</strong>${it.outputPath ? `<div class="muted small">${esc(it.outputPath.split("/").pop())}</div>` : ""}${it.aspectRatio ? `<div class="muted small">${it.aspectRatio}</div>` : ""}</td>
      <td class="prompt-cell"><div class="prompt-preview" data-toggle>${esc(it.prompt)}</div>${it.error ? `<div class="err">${esc(it.error)}</div>` : ""}</td>
      <td><span class="status ${it.status}">${label(it.status)}</span>${it.attempts > 1 ? `<div class="muted small">${it.attempts} attempts</div>` : ""}</td>
      <td>${thumb}</td><td><div class="actions">${actions.join("")}</div></td></tr>`);
  });
  body.innerHTML = rows.join("") || `<tr><td colspan="7" class="muted">Nothing to show.</td></tr>`;
}

function renderLog(entries) {
  const el = $("log");
  const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 8;
  el.innerHTML = entries.slice(-150).map((e) => `<span class="${e.level}">[${e.t.slice(11, 19)}] ${esc(e.message)}</span>`).join("\n");
  if (atBottom) el.scrollTop = el.scrollHeight;
}

function showSummary(project, run, folder) {
  const s = run.summary || {};
  const elapsed = run.startedAt && run.finishedAt ? Math.round((new Date(run.finishedAt) - new Date(run.startedAt)) / 1000) : null;
  $("summary-body").innerHTML = `<p>Project <strong>${esc(project.name)}</strong></p>
    <div class="summary-grid"><span>Completed</span><strong>${s.completed ?? 0}</strong><span>Failed</span><strong>${s.failed ?? 0}</strong><span>Skipped</span><strong>${s.skipped ?? 0}</strong><span>Total</span><strong>${s.total ?? 0}</strong>${elapsed !== null ? `<span>Time</span><strong>${Math.floor(elapsed / 60)}m ${elapsed % 60}s</strong>` : ""}</div>
    <p class="muted small">Saved to ${esc(folder)}.${s.failed ? " Use Retry Failed to try the failed prompts again." : ""}</p>`;
  $("summary-dialog").showModal();
}

const label = (s) => ({ pending: "Pending", generating: "Generating", completed: "Completed", failed: "Failed", skipped: "Skipped" }[s] || s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
let toastTimer;
function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 4500);
}


// ---------- paste prompts as plain text ----------

let generatedJsonText = null;
$("btn-toggle-paste").addEventListener("click", () => {
  const panel = $("paste-panel");
  panel.classList.toggle("hidden");
  if (!panel.classList.contains("hidden")) $("paste-text").focus();
});
$("btn-paste-txt").addEventListener("click", () => $("paste-file").click());
$("paste-file").addEventListener("change", async () => {
  const f = $("paste-file").files[0];
  if (!f) return;
  $("paste-text").value = await f.text();
  if (!$("paste-project").value.trim()) $("paste-project").value = f.name.replace(/\.[^.]*$/, "");
  $("paste-file").value = "";
  updatePasteCount();
});
$("paste-text").addEventListener("input", updatePasteCount);
function updatePasteCount() {
  const n = splitPrompts($("paste-text").value).length;
  $("paste-count").textContent = n ? `${n} prompt(s) detected` : "";
}
$("btn-paste-convert").addEventListener("click", () => {
  const text = $("paste-text").value;
  if (!text.trim()) { toast("Paste at least one prompt first."); return; }
  const project = $("paste-project").value.trim() || "Untitled Project";
  const file = textToPromptFile(text, { project, defaultAspectRatio: $("paste-aspect").value || null });
  if (!file.prompts.length) { toast("No prompts were found in the text."); return; }
  generatedJsonText = JSON.stringify(file, null, 2);
  const sourceName = `${file.project.replace(/[^\w.-]+/g, "_")}.json`;
  const result = validatePromptFile(generatedJsonText, sourceName);
  showValidation(result);
  if (result.ok) {
    pendingValidation = result;
    pendingSourceName = sourceName;
    showPreview(result);
    $("btn-download-json").classList.remove("hidden");
    $("preview").scrollIntoView({ behavior: "smooth", block: "start" });
  } else {
    hidePreview();
  }
});
$("btn-download-json").addEventListener("click", () => {
  if (!generatedJsonText) return;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([generatedJsonText], { type: "application/json" }));
  a.download = pendingSourceName || "prompts.json";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
});

// ---------- boot: recover after a reload ----------

(async function boot() {
  if (state.project) {
    const interrupted = state.project.items.some((it) => it.status === STATUS.GENERATING);
    if (interrupted) { state.project.items = recoverInterrupted(state.project.items); log("warn", "Recovered an unfinished image after a reload; it will be retried."); }
    if (isBusy()) { state.run.state = RUN.PAUSED; log("warn", "The page was reloaded while running. Press Resume to continue."); }
    state.run.currentIndex = -1;
    for (const it of state.project.items) if (it.previewUrl && !it.previewUrl.startsWith("blob:")) it.previewUrl = null;
  }
  render();
  await Promise.all([checkExtension(), refreshFolderStatus()]);
})();
window.__bulkgen = { state, get rootHandle() { return rootHandle; } };
