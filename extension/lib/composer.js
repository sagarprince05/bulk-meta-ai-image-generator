// Chat-style prompt composer: type prompts, attach files/folders, or ask the AI prompt writer.
// Produces one editable draft list; "Generate images with Meta AI" turns it into a project.
import { validatePromptFile, sanitizeComponent, stripImageExtension } from "./validation.js";
import { splitPrompts, suggestFilename, extractAspectRatio } from "./parse-prompts.js";

const DRAFT_KEY = "bulkgen.draft.v1";
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function initComposer({ root, aiEndpoint, onUseProjectText, toast }) {
  const $ = (sel) => root.querySelector(sel);
  const state = loadDraft();
  let attachments = []; // {name, text, kind:'json'|'text', count}
  let aiAvailable = null; // unknown until first check

  root.innerHTML = `
    <div class="thread" id="cmp-thread"></div>
    <div class="composer" id="cmp-box">
      <div class="chips" id="cmp-chips"></div>
      <textarea id="cmp-text" rows="4" placeholder="Type your prompts here (one per line, or a numbered list), or describe what you want and let AI write the prompts…"></textarea>
      <div class="composer-bar">
        <button type="button" class="icon-btn" id="cmp-attach">📎 Attach files</button>
        <button type="button" class="icon-btn" id="cmp-folder">📁 Attach folder</button>
        <input type="file" id="cmp-file-input" accept=".json,.txt,.md,application/json,text/plain" multiple hidden />
        <input type="file" id="cmp-folder-input" webkitdirectory directory multiple hidden />
        <span class="mode" id="cmp-mode"><span class="on" data-mode="add">Add my text as prompts</span><span data-mode="ai">Let AI write prompts</span></span>
        <select id="cmp-aspect" class="icon-btn" title="Aspect ratio for new prompts"><option value="16:9">16:9</option><option value="9:16">9:16</option><option value="1:1">1:1</option><option value="4:3">4:3</option><option value="3:4">3:4</option><option value="">No ratio</option></select>
        <input type="number" id="cmp-count" class="icon-btn hidden" min="1" max="50" value="10" title="How many prompts to write" style="width:70px" />
        <button type="button" class="send" id="cmp-send" title="Add to list (Ctrl+Enter)">➤</button>
      </div>
      <div class="hint" id="cmp-hint">Accepted: .json (tool format), .txt / .md (plain prompts), or a folder with those files. Ctrl+Enter = send.</div>
    </div>
    <div class="list-head">
      <h3>Prompt list · <span id="cmp-total">0</span> prompts · Project <input id="cmp-project" type="text" placeholder="Project name" /></h3>
      <span class="muted small">Edit any row. Filenames are auto-suggested.</span>
    </div>
    <div class="prompt-list" id="cmp-list"></div>
    <div class="sticky-actions">
      <button type="button" class="btn" id="cmp-add-row">+ Add a prompt</button>
      <button type="button" class="btn ghost" id="cmp-download">Download as JSON</button>
      <button type="button" class="btn ghost" id="cmp-clear">Clear list</button>
      <span class="spacer"></span>
      <span class="muted small" id="cmp-summary"></span>
      <button type="button" class="btn primary" id="cmp-use">Generate images with Meta AI</button>
    </div>`;

  const thread = $("#cmp-thread");
  const textarea = $("#cmp-text");
  const modeEl = $("#cmp-mode");
  const countEl = $("#cmp-count");
  let mode = "add";

  // ---------- helpers ----------
  function say(role, html) {
    const t = new Date();
    const hh = `${t.getHours()}:${String(t.getMinutes()).padStart(2, "0")}`;
    thread.insertAdjacentHTML("beforeend", `<div class="msg ${role}">${html}<div class="meta">${role === "user" ? "You" : "Tool"} · ${hh}</div></div>`);
    thread.scrollTop = thread.scrollHeight;
    while (thread.children.length > 30) thread.firstChild.remove();
  }
  function saveDraft() {
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(state)); } catch { /* ignore */ }
    renderList();
  }
  function uniqueName(base) {
    const taken = new Set(state.items.map((i) => i.filename.toLowerCase()));
    if (!taken.has(base.toLowerCase())) return base;
    let n = 2;
    while (taken.has(`${base}_${n}`.toLowerCase())) n++;
    return `${base}_${n}`;
  }
  function addPrompts(prompts, { aspectRatio, filenames } = {}) {
    let added = 0;
    prompts.forEach((raw, i) => {
      const { prompt, aspectRatio: inline } = extractAspectRatio(raw);
      if (!prompt.trim()) return;
      const base = filenames?.[i] ? sanitizeComponent(stripImageExtension(filenames[i])) : suggestFilename(prompt);
      state.items.push({ filename: uniqueName(base || "prompt"), prompt, aspectRatio: inline || aspectRatio || null });
      added++;
    });
    saveDraft();
    return added;
  }
  function setMode(next) {
    mode = next;
    modeEl.querySelectorAll("span").forEach((s) => s.classList.toggle("on", s.dataset.mode === next));
    countEl.classList.toggle("hidden", next !== "ai");
    textarea.placeholder = next === "ai"
      ? "Describe what you want, e.g. 10 Diwali scenes: courtyard diyas, palace fireworks, Lakshmi puja… photorealistic, cinematic"
      : "Type your prompts here (one per line, or a numbered list)…";
  }

  // ---------- attachments ----------
  async function ingestFiles(files) {
    const list = [...files].filter((f) => /\.(json|txt|md)$/i.test(f.name));
    if (!list.length) { toast("Only .json, .txt or .md files are used."); return; }
    for (const f of list) {
      if (f.size > 50 * 1024 * 1024) { toast(`${f.name} is larger than 50 MB and was skipped.`); continue; }
      const text = await f.text();
      const kind = /\.json$/i.test(f.name) ? "json" : "text";
      let count = 0;
      let error = null;
      if (kind === "json") {
        const r = validatePromptFile(text, f.name);
        if (r.ok) count = r.items.length; else error = r.errors[0];
      } else {
        count = splitPrompts(text).length;
      }
      attachments.push({ name: f.webkitRelativePath || f.name, text, kind, count, error });
    }
    renderChips();
  }
  function renderChips() {
    $("#cmp-chips").innerHTML = attachments.map((a, i) => `<span class="chip">${a.kind === "json" ? "🧾" : "📄"} <b>${esc(a.name)}</b> ${a.error ? `<span class="err">${esc(a.error)}</span>` : `${a.count} prompt(s)`} <span class="x" data-i="${i}" title="Remove">✕</span></span>`).join("");
  }
  $("#cmp-chips").addEventListener("click", (e) => { const x = e.target.closest(".x"); if (x) { attachments.splice(Number(x.dataset.i), 1); renderChips(); } });
  $("#cmp-attach").addEventListener("click", () => $("#cmp-file-input").click());
  $("#cmp-folder").addEventListener("click", () => $("#cmp-folder-input").click());
  $("#cmp-file-input").addEventListener("change", (e) => { ingestFiles(e.target.files); e.target.value = ""; });
  $("#cmp-folder-input").addEventListener("change", (e) => { ingestFiles(e.target.files); e.target.value = ""; });
  const box = $("#cmp-box");
  ["dragenter", "dragover"].forEach((ev) => box.addEventListener(ev, (e) => { e.preventDefault(); box.classList.add("drag"); }));
  ["dragleave", "drop"].forEach((ev) => box.addEventListener(ev, (e) => { e.preventDefault(); box.classList.remove("drag"); }));
  box.addEventListener("drop", (e) => { if (e.dataTransfer.files.length) ingestFiles(e.dataTransfer.files); });

  // ---------- sending ----------
  modeEl.addEventListener("click", (e) => { const s = e.target.closest("[data-mode]"); if (s) setMode(s.dataset.mode); });
  textarea.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); } });
  $("#cmp-send").addEventListener("click", send);

  async function send() {
    const text = textarea.value.trim();
    const aspect = $("#cmp-aspect").value || null;
    if (!text && !attachments.length) { toast("Type something or attach a file first."); return; }

    // 1) attachments always become prompts
    let addedFromFiles = 0;
    const fileNotes = [];
    for (const a of attachments) {
      if (a.error) { fileNotes.push(`${a.name}: skipped (${a.error})`); continue; }
      if (a.kind === "json") {
        const r = validatePromptFile(a.text, a.name);
        if (!state.project && r.projectName && r.projectName !== "Untitled Project") state.project = r.projectName;
        addedFromFiles += addPrompts(r.items.map((it) => it.prompt), { filenames: r.items.map((it) => it.filename), aspectRatio: aspect });
        r.items.forEach((it, i) => { if (it.aspectRatio) state.items[state.items.length - r.items.length + i].aspectRatio = it.aspectRatio; });
      } else {
        addedFromFiles += addPrompts(splitPrompts(a.text), { aspectRatio: aspect });
      }
      fileNotes.push(`${a.name}: ${a.count} prompt(s)`);
    }
    if (attachments.length) {
      say("user", `${attachments.map((a) => `<b>${esc(a.name)}</b>`).join(", ")} attached${text ? `<br>${esc(text)}` : ""}`);
      say("tool", `Added <b>${addedFromFiles} prompt(s)</b> from ${attachments.length} file(s). ${esc(fileNotes.join(" · "))}`);
      attachments = [];
      renderChips();
      saveDraft();
    }

    // 2) typed text: either prompts or an AI brief
    if (text) {
      if (mode === "add") {
        const prompts = splitPrompts(text);
        const n = addPrompts(prompts, { aspectRatio: aspect });
        say("user", esc(text).slice(0, 600));
        say("tool", n ? `Added <b>${n} prompt(s)</b> exactly as written. Edit them below, then press <b>Generate images with Meta AI</b>.` : "No prompts found in that text.");
        if (n) textarea.value = "";
      } else {
        await askAi(text, aspect);
      }
    }
    saveDraft();
  }

  async function askAi(brief, aspect) {
    const count = Math.max(1, Math.min(50, Number(countEl.value) || 10));
    say("user", esc(brief).slice(0, 600));
    const pending = document.createElement("div");
    pending.className = "msg tool";
    pending.innerHTML = `Writing ${count} prompts with AI…<div class="meta">AI prompt writer</div>`;
    thread.appendChild(pending);
    $("#cmp-send").disabled = true;
    try {
      const r = await callAi({ task: "write", brief, count, aspectRatio: aspect, existing: state.items.slice(-40).map((i) => i.prompt) });
      const n = addPrompts(r.prompts, { aspectRatio: aspect });
      pending.innerHTML = `Wrote <b>${n} prompt(s)</b> with AI and added them as #${state.items.length - n + 1}–#${state.items.length}. Review or edit them below, then press <b>Generate images with Meta AI</b>.<div class="meta">AI prompt writer${r.usage ? ` · ${r.usage.input + r.usage.output} tokens` : ""}</div>`;
      textarea.value = "";
    } catch (exc) {
      pending.innerHTML = `<span class="err">${esc(exc.message)}</span> You can switch to "Add my text as prompts" and type them yourself.<div class="meta">AI prompt writer</div>`;
    } finally {
      $("#cmp-send").disabled = false;
    }
  }

  async function callAi(payload) {
    if (!aiEndpoint) throw new Error("AI prompt writing is not available in this build.");
    const resp = await fetch(aiEndpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.error || `AI request failed (${resp.status}).`);
    return data;
  }

  async function checkAi() {
    if (!aiEndpoint) { aiAvailable = false; }
    else {
      try {
        const resp = await fetch(aiEndpoint, { method: "OPTIONS" });
        aiAvailable = resp.ok || resp.status === 204;
      } catch { aiAvailable = false; }
    }
    modeEl.querySelector('[data-mode="ai"]').classList.toggle("hidden", !aiAvailable);
    root.querySelectorAll("[data-rewrite]").forEach((b) => b.classList.toggle("hidden", !aiAvailable));
    if (!aiAvailable && mode === "ai") setMode("add");
  }

  // ---------- list editing ----------
  function renderList() {
    const list = $("#cmp-list");
    $("#cmp-total").textContent = state.items.length;
    $("#cmp-project").value = state.project || "";
    if (!state.items.length) {
      list.innerHTML = `<div class="muted small" style="padding:10px 4px">No prompts yet. Type some above, attach a file, or ask the AI.</div>`;
    } else {
      list.innerHTML = state.items.map((it, i) => `
        <div class="prompt-row" data-i="${i}">
          <div class="num">${i + 1}</div>
          <input type="text" class="row-name" value="${esc(it.filename)}" title="File name (without extension)" />
          <textarea class="row-prompt" rows="2">${esc(it.prompt)}</textarea>
          <div class="row-actions">
            <select class="row-aspect" title="Aspect ratio"><option value="" ${!it.aspectRatio ? "selected" : ""}>no ratio</option>${["16:9", "9:16", "1:1", "4:3", "3:4"].map((a) => `<option ${it.aspectRatio === a ? "selected" : ""}>${a}</option>`).join("")}</select>
            <button type="button" class="btn small ghost ${aiAvailable ? "" : "hidden"}" data-rewrite>Rewrite</button>
            <button type="button" class="btn small ghost" data-delete>Delete</button>
          </div>
        </div>`).join("");
    }
    const ratios = [...new Set(state.items.map((i) => i.aspectRatio).filter(Boolean))];
    $("#cmp-summary").textContent = state.items.length ? `${state.items.length} prompt(s) ready${ratios.length ? ` · ${ratios.join(", ")}` : ""}` : "";
    $("#cmp-use").disabled = !state.items.length;
    $("#cmp-download").disabled = !state.items.length;
  }
  $("#cmp-list").addEventListener("input", (e) => {
    const row = e.target.closest(".prompt-row");
    if (!row) return;
    const it = state.items[Number(row.dataset.i)];
    if (e.target.classList.contains("row-name")) it.filename = e.target.value;
    if (e.target.classList.contains("row-prompt")) it.prompt = e.target.value;
    if (e.target.classList.contains("row-aspect")) it.aspectRatio = e.target.value || null;
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(state)); } catch { /* ignore */ }
    $("#cmp-summary").textContent = `${state.items.length} prompt(s) ready`;
  });
  $("#cmp-list").addEventListener("click", async (e) => {
    const row = e.target.closest(".prompt-row");
    if (!row) return;
    const i = Number(row.dataset.i);
    if (e.target.closest("[data-delete]")) { state.items.splice(i, 1); saveDraft(); }
    if (e.target.closest("[data-rewrite]")) {
      const btn = e.target.closest("[data-rewrite]");
      btn.disabled = true; btn.textContent = "…";
      try {
        const r = await callAi({ task: "rewrite", brief: state.items[i].prompt, aspectRatio: state.items[i].aspectRatio });
        if (r.prompts?.[0]) { state.items[i].prompt = r.prompts[0]; saveDraft(); }
      } catch (exc) { toast(exc.message); btn.disabled = false; btn.textContent = "Rewrite"; }
    }
  });
  $("#cmp-project").addEventListener("input", (e) => { state.project = e.target.value; try { localStorage.setItem(DRAFT_KEY, JSON.stringify(state)); } catch { /* ignore */ } });
  $("#cmp-add-row").addEventListener("click", () => { state.items.push({ filename: uniqueName("prompt"), prompt: "", aspectRatio: $("#cmp-aspect").value || null }); saveDraft(); $("#cmp-list").querySelector(".prompt-row:last-child textarea")?.focus(); });
  $("#cmp-clear").addEventListener("click", () => { if (!state.items.length || confirm("Clear all prompts from the list?")) { state.items = []; saveDraft(); } });

  function buildFileObject() {
    const project = (state.project || "").trim() || "Untitled Project";
    const prompts = state.items.filter((it) => it.prompt.trim()).map((it, i) => {
      const o = { id: i + 1, filename: (it.filename || "").trim() || suggestFilename(it.prompt), prompt: it.prompt };
      if (it.aspectRatio) o.aspect_ratio = it.aspectRatio;
      return o;
    });
    return { project, prompts };
  }
  $("#cmp-download").addEventListener("click", () => {
    const file = buildFileObject();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(file, null, 2)], { type: "application/json" }));
    a.download = `${sanitizeComponent(file.project).replace(/\s+/g, "_") || "prompts"}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  });
  $("#cmp-use").addEventListener("click", () => {
    const file = buildFileObject();
    if (!file.prompts.length) { toast("Add at least one prompt with text."); return; }
    const text = JSON.stringify(file);
    const r = validatePromptFile(text, `${file.project}.json`);
    if (!r.ok) { toast(r.errors[0]); return; }
    onUseProjectText(r, `${file.project}.json`);
  });

  // ---------- boot ----------
  setMode("add");
  renderList();
  checkAi();
  if (state.items.length) say("tool", `Restored <b>${state.items.length} prompt(s)</b> from your last session.`);

  return {
    clear() { state.items = []; state.project = ""; saveDraft(); },
    get count() { return state.items.length; },
  };
}

function loadDraft() {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    const s = raw ? JSON.parse(raw) : null;
    if (s && Array.isArray(s.items)) return { project: s.project || "", items: s.items.filter((i) => i && typeof i.prompt === "string").map((i) => ({ filename: String(i.filename || ""), prompt: i.prompt, aspectRatio: i.aspectRatio || null })) };
  } catch { /* ignore */ }
  return { project: "", items: [] };
}
