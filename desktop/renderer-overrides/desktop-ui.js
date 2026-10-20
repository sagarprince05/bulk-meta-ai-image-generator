// Desktop-only UI: hides the web setup card and shows a slim bar with Meta AI login state,
// the output folder picker and a toggle for the built-in Meta AI panel.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function initDesktopUi({ onFolderChanged }) {
  const d = window.desktop;
  if (!d) return;
  $("setup-card")?.classList.add("hidden");
  $("btn-test")?.classList.add("hidden");
  // The web page numbers its sections (1. setup, 2. prompts...); the desktop app has no setup step.
  document.querySelectorAll("main h2").forEach((h) => { h.textContent = h.textContent.replace(/^\d+\.\s*/, ""); });

  const bar = document.createElement("section");
  bar.id = "desktop-bar";
  bar.className = "card desktop-bar";
  bar.innerHTML = `
    <div class="db-item">
      <span id="db-login-dot" class="dot"></span>
      <div class="db-text"><div class="db-title">Meta AI</div><div id="db-login-text" class="muted small">Checking…</div></div>
      <button id="db-login" class="btn primary small">Log in to Meta AI</button>
      <button id="db-logout" class="btn ghost small hidden" title="Sign out of Meta AI inside ImageRush">Log out</button>
    </div>
    <div class="db-item">
      <span class="dot ok"></span>
      <div class="db-text"><div class="db-title">Output folder</div><div id="db-folder" class="muted small"></div></div>
      <button id="db-choose" class="btn small">Select Output Folder</button>
      <button id="db-open" class="btn ghost small">Open</button>
    </div>
    <div class="db-item db-right muted small">Meta AI runs in the panel on the right.</div>`;
  const main = document.querySelector("main");
  main.insertBefore(bar, main.firstChild);

  let status = { loggedIn: false, ready: false };
  function renderStatus() {
    const dot = $("db-login-dot");
    const text = $("db-login-text");
    if (status.loggedIn && status.ready) { dot.className = "dot ok"; text.textContent = "Logged in. Ready to generate."; $("db-login").classList.add("hidden"); $("db-logout").classList.remove("hidden"); }
    else if (status.loggedIn) { dot.className = "dot warn"; text.textContent = "Logged in, waiting for the chat box to load…"; $("db-login").classList.add("hidden"); $("db-logout").classList.remove("hidden"); }
    else { dot.className = "dot bad"; text.textContent = "Not logged in. Log in once in the Meta AI panel; you stay logged in afterwards."; $("db-login").classList.remove("hidden"); $("db-logout").classList.add("hidden"); }
    $("login-dot") && ($("login-dot").className = `dot ${status.loggedIn ? "ok" : "bad"}`);
  }
  d.meta.onStatus((s) => { status = s || status; renderStatus(); });
  d.meta.status().then((s) => { status = s || status; renderStatus(); }).catch(() => {});
  setInterval(() => d.meta.status().catch(() => {}), 5000);

  $("db-login").addEventListener("click", () => d.meta.login());
  $("db-logout").addEventListener("click", async () => {
    if (!confirm("Log out of Meta AI inside ImageRush?")) return;
    status = { loggedIn: false, ready: false }; renderStatus();
    await d.meta.logout();
  });

  async function refreshFolder() {
    const r = await d.fs.getRoot();
    $("db-folder").textContent = r.root;
    return r.root;
  }
  refreshFolder();
  $("db-choose").addEventListener("click", async () => { const r = await d.fs.chooseRoot(); $("db-folder").textContent = r.root; if (r.changed) onFolderChanged?.(r.root); });
  $("db-open").addEventListener("click", () => d.fs.openFolder(""));

  function renderPanel(p) { document.body.style.marginRight = `${p.width}px`; }
  d.panel.onChange(renderPanel);
  d.panel.get().then(renderPanel).catch(() => {});
}
