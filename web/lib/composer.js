// Chat-style composer: type ideas, attach files/folders, or ask the AI prompt writer.
// It fills the draft list rendered by the host page (renderDraft) and starts a batch via onUse.
import { validatePromptFile, sanitizeComponent, stripImageExtension } from "./validation.js";
import { splitPrompts, suggestFilename, extractAspectRatio } from "./parse-prompts.js";

const DRAFT_KEY = "bulkgen.draft.v1";
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ICON = {
  attach: '<svg class="ic" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/></svg>',
  folder: '<svg class="ic" viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  land: '<svg class="ic" viewBox="0 0 24 24"><rect x="3" y="6" width="18" height="12" rx="2"/></svg>',
  port: '<svg class="ic" viewBox="0 0 24 24"><rect x="6" y="3" width="12" height="18" rx="2"/></svg>',
  square: '<svg class="ic" viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>',
  magic: '<svg class="ic" viewBox="0 0 24 24"><path d="M15 4V2M15 10V8M9 7h2M19 7h2M17.8 4.2l1.4-1.4M12.2 4.2l-1.4-1.4M3 21l9-9M15 7l2 2"/></svg>',
  up: '<svg class="ic" viewBox="0 0 24 24"><path d="M12 19V5M5 12l7-7 7 7"/></svg>',
};

export function initComposer({ root, aiEndpoint, onUse, onDraftChanged, toast }) {
  const $ = (sel) => root.querySelector(sel);
  const state = loadDraft();
  let attachments = [];
  let aiAvailable = null;
  let mode = "add";
  let aspect = "16:9";

  root.innerHTML = `
    <div class="thread" id="cmp-thread"></div>
    <div class="composer" id="cmp-box">
      <div class="chips" id="cmp-chips"></div>
      <textarea id="cmp-text" rows="3" placeholder="Describe your images, one idea per line. Example: A sunset over a beach / A cozy coffee shop in winter"></textarea>
      <div class="composer-bar">
        <div class="bar-left">
          <button type="button" class="icon-btn" id="cmp-attach">${ICON.attach} Attach a file</button>
          <button type="button" class="icon-btn" id="cmp-folder">${ICON.folder} Attach a folder</button>
          <input type="file" id="cmp-file-input" accept=".json,.txt,.md,application/json,text/plain" multiple hidden />
          <input type="file" id="cmp-folder-input" webkitdirectory directory multiple hidden />
          <span class="seg" id="cmp-ratio">
            <button type="button" class="on" data-ratio="16:9" title="Landscape">${ICON.land} <span>Landscape 16:9</span></button>
            <button type="button" data-ratio="9:16" title="Portrait">${ICON.port} <span>Portrait 9:16</span></button>
            <button type="button" data-ratio="1:1" title="Square">${ICON.square} <span>Square 1:1</span></button>
          </span>
        </div>
        <div class="bar-right">
          <span class="seg" id="cmp-mode">
            <button type="button" class="on" data-mode="add">Use my words exactly</button>
            <button type="button" data-mode="ai">${ICON.magic} Let AI write better descriptions</button>
          </span>
          <input type="number" id="cmp-count" class="icon-btn hidden" min="1" max="50" value="10" title="How many ideas to write" style="width:64px" />
          <button type="button" class="send" id="cmp-send" title="Add to list (Ctrl+Enter)">${ICON.up}</button>
        </div>
      </div>
      <div class="hint">Accepted: .txt, .md or .json files, or a whole folder. Ctrl+Enter sends.</div>
    </div>`;

  const thread = $("#cmp-thread");
  const textarea = $("#cmp-text");
  const countEl = $("#cmp-count");

  function say(role, html) {
    const t = new Date();
    const hh = `${t.getHours()}:${String(t.getMinutes()).padStart(2, "0")}`;
    thread.insertAdjacentHTML("beforeend", `<div class="msg ${role}">${html}<div class="meta">${role === "user" ? "You" : "ImageRush"} · ${hh}</div></div>`);
    thread.scrollTop = thread.scrollHeight;
    while (thread.children.length > 20) thread.firstChild.remove();
  }
  function persist() { try { localStorage.setItem(DRAFT_KEY, JSON.stringify(state)); } catch { /* ignore */ } }
  function changed() { persist(); onDraftChanged?.(api); }
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
      state.items.push({ filename: uniqueName(base || "image"), prompt, aspectRatio: inline || aspectRatio || null });
      added++;
    });
    if (added) changed();
    return added;
  }
  function setMode(next) {
    mode = next;
    $("#cmp-mode").querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.mode === next));
    countEl.classList.toggle("hidden", next !== "ai");
    textarea.placeholder = next === "ai"
      ? "Tell the AI what you need, e.g. 10 Diwali scenes: courtyard diyas, palace fireworks, family moments. Warm and photorealistic."
      : "Describe your images, one idea per line. Example: A sunset over a beach / A cozy coffee shop in winter";
  }
  function setRatio(r) {
    aspect = r;
    $("#cmp-ratio").querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.ratio === r));
  }

  // ---------- attachments ----------
  async function ingestFiles(files) {
    const list = [...files].filter((f) => /\.(json|txt|md)$/i.test(f.name));
    if (!list.length) { toast("Only .txt, .md or .json files can be used."); return; }
    for (const f of list) {
      if (f.size > 50 * 1024 * 1024) { toast(`${f.name} is too large and was skipped.`); continue; }
      const text = await f.text();
      const kind = /\.json$/i.test(f.name) ? "json" : "text";
      let count = 0, error = null;
      if (kind === "json") { const r = validatePromptFile(text, f.name); if (r.ok) count = r.items.length; else error = r.errors[0]; }
      else count = splitPrompts(text).length;
      attachments.push({ name: f.webkitRelativePath || f.name, text, kind, count, error });
    }
    renderChips();
  }
  function renderChips() {
    $("#cmp-chips").innerHTML = attachments.map((a, i) => `<span class="chip">${a.kind === "json" ? "🧾" : "📄"} <b>${esc(a.name)}</b> ${a.error ? `<span class="err">${esc(a.error)}</span>` : `${a.count} idea(s)`} <span class="x" data-i="${i}" title="Remove">✕</span></span>`).join("");
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
  $("#cmp-mode").addEventListener("click", (e) => { const b = e.target.closest("[data-mode]"); if (b) setMode(b.dataset.mode); });
  $("#cmp-ratio").addEventListener("click", (e) => { const b = e.target.closest("[data-ratio]"); if (b) setRatio(b.dataset.ratio); });
  textarea.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); } });
  $("#cmp-send").addEventListener("click", send);

  async function send() {
    const text = textarea.value.trim();
    if (!text && !attachments.length) { toast("Type an idea or attach a file first."); return; }
    let addedFromFiles = 0;
    const notes = [];
    for (const a of attachments) {
      if (a.error) { notes.push(`${a.name}: skipped (${a.error})`); continue; }
      if (a.kind === "json") {
        const r = validatePromptFile(a.text, a.name);
        if (!state.project && r.projectName && r.projectName !== "Untitled Project") state.project = r.projectName;
        const start = state.items.length;
        addedFromFiles += addPrompts(r.items.map((it) => it.prompt), { filenames: r.items.map((it) => it.filename), aspectRatio: aspect });
        r.items.forEach((it, i) => { if (it.aspectRatio && state.items[start + i]) state.items[start + i].aspectRatio = it.aspectRatio; });
      } else {
        addedFromFiles += addPrompts(splitPrompts(a.text), { aspectRatio: aspect });
      }
      notes.push(`${a.name}: ${a.count} idea(s)`);
    }
    if (attachments.length) {
      say("user", `${attachments.map((a) => `<b>${esc(a.name)}</b>`).join(", ")} attached${text ? `<br>${esc(text)}` : ""}`);
      say("tool", `Added <b>${addedFromFiles} idea(s)</b> from ${attachments.length} file(s). ${esc(notes.join(" · "))}`);
      attachments = [];
      renderChips();
      changed();
    }
    if (text) {
      if (mode === "add") {
        const n = addPrompts(splitPrompts(text), { aspectRatio: aspect });
        say("user", esc(text).slice(0, 600));
        say("tool", n ? `Added <b>${n} idea(s)</b> exactly as written. Press <b>Create all images</b> when you are ready.` : "I could not find any ideas in that text.");
        if (n) textarea.value = "";
      } else {
        await askAi(text);
      }
    }
  }

  async function askAi(brief) {
    const count = Math.max(1, Math.min(50, Number(countEl.value) || 10));
    say("user", esc(brief).slice(0, 600));
    const pending = document.createElement("div");
    pending.className = "msg tool";
    pending.innerHTML = `Writing ${count} descriptions…<div class="meta">AI writer</div>`;
    thread.appendChild(pending);
    $("#cmp-send").disabled = true;
    try {
      const r = await callAi({ task: "write", brief, count, aspectRatio: aspect, existing: state.items.slice(-40).map((i) => i.prompt) });
      const n = addPrompts(r.prompts, { aspectRatio: aspect });
      pending.innerHTML = `Wrote <b>${n} description(s)</b> and added them to your list. Edit any of them, then press <b>Create all images</b>.<div class="meta">AI writer</div>`;
      textarea.value = "";
    } catch (exc) {
      pending.innerHTML = `<span class="err-text">${esc(exc.message)}</span> You can switch to "Use my words exactly" and type the ideas yourself.<div class="meta">AI writer</div>`;
    } finally {
      $("#cmp-send").disabled = false;
    }
  }

  async function callAi(payload) {
    if (aiEndpoint === "desktop" && window.desktop?.ai) return window.desktop.ai.prompts(payload);
    if (!aiEndpoint) throw new Error("AI writing is not available here.");
    const resp = await fetch(aiEndpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.error || `AI request failed (${resp.status}).`);
    return data;
  }

  async function checkAi() {
    if (!aiEndpoint) aiAvailable = false;
    else if (aiEndpoint === "desktop" && window.desktop?.ai) aiAvailable = await window.desktop.ai.available().catch(() => false);
    else { try { const resp = await fetch(aiEndpoint, { method: "OPTIONS" }); aiAvailable = resp.ok || resp.status === 204; } catch { aiAvailable = false; } }
    $('[data-mode="ai"]').classList.toggle("hidden", !aiAvailable);
    if (!aiAvailable && mode === "ai") setMode("add");
    onDraftChanged?.(api);
  }

  function buildFileObject() {
    const project = (state.project || "").trim() || defaultProjectName();
    const prompts = state.items.filter((it) => it.prompt.trim()).map((it, i) => {
      const o = { id: i + 1, filename: (it.filename || "").trim() || suggestFilename(it.prompt), prompt: it.prompt };
      if (it.aspectRatio) o.aspect_ratio = it.aspectRatio;
      return o;
    });
    return { project, prompts };
  }
  function defaultProjectName() {
    const d = new Date();
    return `Images ${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  const api = {
    get items() { return state.items; },
    get project() { return state.project; },
    set project(v) { state.project = v; persist(); },
    get aiAvailable() { return aiAvailable; },
    get count() { return state.items.length; },
    update(i, patch) { Object.assign(state.items[i], patch); persist(); },
    remove(i) { state.items.splice(i, 1); changed(); },
    clear() { state.items = []; state.project = ""; changed(); },
    addBlank() { state.items.push({ filename: uniqueName("image"), prompt: "", aspectRatio: aspect }); changed(); },
    async rewrite(i) {
      const r = await callAi({ task: "rewrite", brief: state.items[i].prompt, aspectRatio: state.items[i].aspectRatio });
      if (r.prompts?.[0]) { state.items[i].prompt = r.prompts[0]; changed(); }
    },
    buildFileObject,
    use() {
      const file = buildFileObject();
      if (!file.prompts.length) { toast("Add at least one idea first."); return false; }
      const r = validatePromptFile(JSON.stringify(file), `${file.project}.json`);
      if (!r.ok) { toast(r.errors[0]); return false; }
      return onUse(r, `${file.project}.json`);
    },
    say,
  };

  setMode("add");
  setRatio("16:9");
  checkAi();
  if (state.items.length) say("tool", `Welcome back. <b>${state.items.length} idea(s)</b> from last time are still in your list.`);
  return api;
}

function loadDraft() {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    const s = raw ? JSON.parse(raw) : null;
    if (s && Array.isArray(s.items)) return { project: s.project || "", items: s.items.filter((i) => i && typeof i.prompt === "string").map((i) => ({ filename: String(i.filename || ""), prompt: i.prompt, aspectRatio: i.aspectRatio || null })) };
  } catch { /* ignore */ }
  return { project: "", items: [] };
}
