import { validatePromptFile } from "./lib/validation.js";
import { splitPrompts, textToPromptFile } from "./lib/parse-prompts.js";
import { STATUS, RUN, DEFAULT_SETTINGS, projectFolderOf } from "./lib/queue.js";

const $ = (id) => document.getElementById(id);
let state = null;
let pendingValidation = null;
let pendingSourceName = "";
let shownSummaryFor = null;

// ---------- messaging ----------

function send(type, payload = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, ...payload }, (reply) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!reply) return reject(new Error("No reply from the background worker."));
      if (reply.ok === false) return reject(new Error(reply.error || "Unknown error"));
      resolve(reply);
    });
  });
}

async function refresh() {
  try {
    state = await send("get_state");
    render();
  } catch (exc) {
    toast(exc.message);
  }
}

async function action(type, payload) {
  try {
    const reply = await send(type, payload);
    if (reply.project !== undefined) { state = reply; render(); }
    return reply;
  } catch (exc) {
    toast(exc.message);
    return null;
  }
}

chrome.runtime.onMessage.addListener((msg) => { if (msg?.type === "state_changed") refresh(); });

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
  if (!/\.json$/i.test(file.name) && file.type !== "application/json") {
    showValidation({ ok: false, errors: [`"${file.name}" is not a .json file.`], warnings: [] });
    return;
  }
  if (file.size > 50 * 1024 * 1024) {
    showValidation({ ok: false, errors: ["The file is larger than 50 MB."], warnings: [] });
    return;
  }
  const text = await file.text();
  const result = validatePromptFile(text, file.name);
  showValidation(result);
  if (result.ok) {
    pendingValidation = result;
    pendingSourceName = file.name;
    showPreview(result);
  } else {
    hidePreview();
  }
}

function showValidation(result) {
  const box = $("validation");
  box.classList.remove("hidden", "error", "warn", "ok");
  const list = (arr) => `<ul>${arr.map((m) => `<li>${escapeHtml(m)}</li>`).join("")}</ul>`;
  if (!result.ok) {
    box.classList.add("error");
    box.innerHTML = `<strong>The file cannot be used.</strong>${list(result.errors)}${result.warnings.length ? `<div class="muted small" style="margin-top:6px">Also: ${escapeHtml(result.warnings.join(" "))}</div>` : ""}`;
  } else if (result.warnings.length) {
    box.classList.add("warn");
    box.innerHTML = `<strong>${result.items.length} prompt(s) found, with notes:</strong>${list(result.warnings)}`;
  } else {
    box.classList.add("ok");
    box.innerHTML = `<strong>${result.items.length} prompt(s) found. The file looks good.</strong>`;
  }
}

function showPreview(result) {
  $("preview").classList.remove("hidden");
  $("preview-title").textContent = `Project "${result.projectName}" with ${result.items.length} prompt(s). Review, then confirm.`;
  $("preview-list").innerHTML = result.items
    .map((it) => `<li><code>${escapeHtml(String(it.promptId))}</code> <strong>${escapeHtml(it.filename)}</strong>${it.aspectRatio ? ` <span class="muted small">(${it.aspectRatio})</span>` : ""}<br><span class="muted">${escapeHtml(it.prompt)}</span></li>`)
    .join("");
}

function hidePreview() {
  $("btn-download-json").classList.add("hidden");
  generatedJsonText = null;
  $("preview").classList.add("hidden");
  pendingValidation = null;
}

$("btn-cancel-preview").addEventListener("click", () => { hidePreview(); $("validation").classList.add("hidden"); });
$("btn-confirm-load").addEventListener("click", async () => {
  if (!pendingValidation) return;
  if (state?.project && state.run.state === RUN.RUNNING) { toast("Stop or pause the running batch before loading a new file."); return; }
  if (state?.project && !confirm(`Replace the current project "${state.project.name}"? Its progress list will be cleared (saved images stay on disk).`)) return;
  await action("load_project", { validation: pendingValidation, sourceName: pendingSourceName });
  hidePreview();
  $("validation").classList.add("hidden");
  toast("Prompts loaded. Press Start Generation when ready.");
});

// ---------- controls ----------

$("btn-start").addEventListener("click", () => action("start"));
$("btn-pause").addEventListener("click", () => action("pause"));
$("btn-resume").addEventListener("click", () => action("resume"));
$("btn-stop").addEventListener("click", () => action("stop"));
$("btn-retry-failed").addEventListener("click", () => action("retry_failed"));
$("btn-open-folder").addEventListener("click", () => action("open_folder"));
$("btn-export").addEventListener("click", async () => { if (await action("export_report")) toast("Report exported to the project folder."); });
$("btn-clear").addEventListener("click", async () => {
  if (state?.run.state === RUN.RUNNING) { toast("Stop the batch first."); return; }
  if (confirm("Clear the loaded project from the dashboard? Files already saved stay in your Downloads folder.")) await action("clear_project");
});
$("btn-clear-log").addEventListener("click", () => $("log").classList.toggle("hidden"));
$("filter-failed").addEventListener("change", render);
$("btn-test").addEventListener("click", async () => {
  toast("Checking the meta.ai tab…");
  try {
    const r = await send("test_connection");
    const lines = [
      r.loggedIn ? "Logged in: yes" : "Logged in: NO — log in to meta.ai in the open tab",
      r.composerFound ? `Chat box found (${r.composerKind})` : "Chat box NOT found",
      r.sendButtonFound ? "Send button found" : "Send button not found (Enter key will be used)",
    ];
    alert(`meta.ai check\n\n${lines.join("\n")}\n\nPage: ${r.url}`);
  } catch (exc) {
    alert(`Could not reach meta.ai: ${exc.message}`);
  }
});

$("btn-settings").addEventListener("click", () => {
  const form = $("settings-form");
  const s = { ...DEFAULT_SETTINGS, ...(state?.settings || {}) };
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === "checkbox") el.checked = !!s[el.name];
    else el.value = s[el.name];
  }
  $("settings-dialog").showModal();
});
$("btn-settings-cancel").addEventListener("click", () => $("settings-dialog").close());
$("settings-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target;
  const settings = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === "checkbox") settings[el.name] = el.checked;
    else if (el.type === "number") settings[el.name] = Number(el.value);
    else settings[el.name] = el.value;
  }
  settings.outputRoot = settings.outputRoot.trim().replace(/^[\\/]+|[\\/]+$/g, "") || "Generated_Images";
  if (/[<>:"|?*]/.test(settings.outputRoot) || settings.outputRoot.includes("..")) { toast("The output folder name contains characters that are not allowed."); return; }
  await action("update_settings", { settings });
  $("settings-dialog").close();
  toast("Settings saved.");
});
$("btn-summary-close").addEventListener("click", () => $("summary-dialog").close());

// ---------- rendering ----------

function render() {
  if (!state) return;
  const { project, run, counts: c, settings } = state;
  const runState = run.state;
  const badge = $("run-badge");
  badge.textContent = { idle: "Idle", running: "Running", pausing: "Pausing…", paused: "Paused", stopping: "Stopping…", stopped: "Stopped", finished: "Finished" }[runState] || runState;
  badge.className = `badge ${runState}`;

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

  const folder = project ? `Downloads/${settings.outputRoot}/${projectFolderOf(project)}/` : "";
  $("folder-hint").textContent = project ? `Images are saved to ${folder} along with generation_manifest.json and failed_prompts.json.` : "";

  const current = project && run.currentIndex >= 0 ? project.items[run.currentIndex] : null;
  $("current").classList.toggle("hidden", !current);
  if (current) {
    $("current-label").textContent = `Image ${run.currentIndex + 1} of ${project.items.length} — ${current.filename}`;
    $("current-prompt").textContent = current.promptSent || current.prompt;
    $("current-status").textContent = current.status === STATUS.GENERATING ? `Generating… (attempt ${current.attempts})` : current.status;
    const img = $("current-preview");
    if (current.previewUrl) { img.src = current.previewUrl; img.classList.remove("hidden"); } else img.classList.add("hidden");
  }

  const hasPending = !!project && project.items.some((it) => it.status === STATUS.PENDING);
  $("btn-start").disabled = !project || !(runState === RUN.IDLE || runState === RUN.FINISHED || runState === RUN.STOPPED) || !hasPending;
  $("btn-pause").disabled = runState !== RUN.RUNNING;
  $("btn-resume").disabled = !(runState === RUN.PAUSED || runState === RUN.STOPPED) || !hasPending;
  $("btn-stop").disabled = !(runState === RUN.RUNNING || runState === RUN.PAUSING || runState === RUN.PAUSED);
  $("btn-retry-failed").disabled = !c || !c.failed;
  $("btn-open-folder").disabled = !project;
  $("btn-export").disabled = !project;
  $("btn-clear").disabled = !project;

  renderQueue(project, run);
  renderLog(state.log);

  if (runState === RUN.FINISHED && run.finishedAt && shownSummaryFor !== run.finishedAt) {
    shownSummaryFor = run.finishedAt;
    showSummary(project, run, folder);
  }
}

function renderQueue(project, run) {
  const body = $("queue-body");
  if (!project) { body.innerHTML = `<tr><td colspan="7" class="muted">Upload a JSON file to see the queue.</td></tr>`; return; }
  const onlyFailed = $("filter-failed").checked;
  const rows = [];
  project.items.forEach((it, index) => {
    if (onlyFailed && it.status !== STATUS.FAILED) return;
    const busy = run.state === RUN.RUNNING || run.state === RUN.PAUSING || run.state === RUN.STOPPING;
    const actions = [];
    if (it.status === STATUS.FAILED) actions.push(`<button class="btn small" data-act="retry_item" data-i="${index}">Retry</button>`);
    if (it.status === STATUS.COMPLETED) actions.push(`<button class="btn small" data-act="retry_item" data-i="${index}" title="Generates this image again; the old file is kept">Regenerate</button>`);
    if (it.status === STATUS.PENDING) actions.push(`<button class="btn small" data-act="skip_item" data-i="${index}">Skip</button>`);
    if (it.status === STATUS.SKIPPED) actions.push(`<button class="btn small" data-act="unskip_item" data-i="${index}">Unskip</button>`);
    if (it.status === STATUS.FAILED && !busy) actions.push(`<button class="btn small ghost" data-act="skip_item" data-i="${index}">Skip</button>`);
    const thumb = it.previewUrl ? `<img class="thumb" src="${escapeAttr(it.previewUrl)}" alt="" loading="lazy" />` : it.status === STATUS.COMPLETED && it.outputPath ? `<span class="muted small">saved</span>` : "";
    rows.push(`<tr class="${index === run.currentIndex ? "active-row" : ""}">
      <td>${it.position}</td>
      <td>${escapeHtml(String(it.promptId))}</td>
      <td><strong>${escapeHtml(it.filename)}</strong>${it.outputPath ? `<div class="muted small">${escapeHtml(it.outputPath.split(/[\\/]/).pop())}</div>` : ""}${it.aspectRatio ? `<div class="muted small">${it.aspectRatio}</div>` : ""}</td>
      <td class="prompt-cell"><div class="prompt-preview" data-toggle>${escapeHtml(it.prompt)}</div>${it.error ? `<div class="err">${escapeHtml(it.error)}</div>` : ""}</td>
      <td><span class="status ${it.status}">${label(it.status)}</span>${it.attempts > 1 ? `<div class="muted small">${it.attempts} attempts</div>` : ""}</td>
      <td>${thumb}</td>
      <td><div class="actions">${actions.join("")}</div></td>
    </tr>`);
  });
  body.innerHTML = rows.join("") || `<tr><td colspan="7" class="muted">Nothing to show.</td></tr>`;
}

$("queue-body").addEventListener("click", async (e) => {
  const toggle = e.target.closest("[data-toggle]");
  if (toggle) { toggle.classList.toggle("open"); return; }
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const index = Number(btn.dataset.i);
  const act = btn.dataset.act;
  if (act === "retry_item" && state.project.items[index].status === STATUS.COMPLETED && !confirm("Generate this image again? The existing file is kept and the new one gets a numbered suffix.")) return;
  await action(act, { index });
});

function renderLog(entries) {
  const el = $("log");
  const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 8;
  el.innerHTML = (entries || []).map((e) => `<span class="${e.level}">[${e.t.slice(11, 19)}] ${escapeHtml(e.message)}</span>`).join("\n");
  if (atBottom) el.scrollTop = el.scrollHeight;
}

function showSummary(project, run, folder) {
  const s = run.summary || {};
  const elapsed = run.startedAt && run.finishedAt ? Math.round((new Date(run.finishedAt) - new Date(run.startedAt)) / 1000) : null;
  $("summary-body").innerHTML = `
    <p>Project <strong>${escapeHtml(project.name)}</strong></p>
    <div class="summary-grid">
      <span>Completed</span><strong>${s.completed ?? 0}</strong>
      <span>Failed</span><strong>${s.failed ?? 0}</strong>
      <span>Skipped</span><strong>${s.skipped ?? 0}</strong>
      <span>Total</span><strong>${s.total ?? 0}</strong>
      ${elapsed !== null ? `<span>Time</span><strong>${Math.floor(elapsed / 60)}m ${elapsed % 60}s</strong>` : ""}
    </div>
    <p class="muted small">Saved to ${escapeHtml(folder)}. The manifest and failed-prompt report are in the same folder.${s.failed ? " Use Retry Failed to try the failed prompts again." : ""}</p>`;
  $("summary-dialog").showModal();
}

// ---------- utils ----------

function label(status) {
  return { pending: "Pending", generating: "Generating", completed: "Completed", failed: "Failed", skipped: "Skipped" }[status] || status;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }
let toastTimer;
function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 4000);
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

if (!globalThis.chrome?.runtime?.sendMessage) {
  document.body.insertAdjacentHTML("afterbegin", '<div class="validation error" style="margin:16px 24px">This page only works when opened from the extension. Load the extension in Chrome and click its toolbar icon.</div>');
} else {
  refresh();
  setInterval(refresh, 5000);
}
