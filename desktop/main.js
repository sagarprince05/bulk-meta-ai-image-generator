// ImageRush desktop: one window with the dashboard on the left and the built-in Meta AI browser on the right.
// Nothing here talks to any server except meta.ai (in the user's own session) and the ImageRush website's
// prompt-writing API (no credentials live in this app).
const { app, BrowserWindow, WebContentsView, ipcMain, dialog, shell, session, net } = require("electron");
const path = require("node:path");
const fs = require("node:fs/promises");
const fssync = require("node:fs");

const META_HOME = "https://www.meta.ai/";
const META_PARTITION = "persist:metaai";
const AI_ENDPOINT = "https://bulk-meta-ai-image-generator-web.vercel.app/api/prompts";
const ADAPTER_SRC = fssync.readFileSync(path.join(__dirname, "meta-adapter.js"), "utf-8");
const MIN_PANEL = 440;

let win = null; // the one app window
let metaView = null; // Meta AI browser docked inside the window
let panelOpen = true;
let settings = { outputRoot: null, panelOpen: true };
let lastStatus = null;
const settingsPath = () => path.join(app.getPath("userData"), "settings.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadSettings() {
  try { settings = { ...settings, ...JSON.parse(fssync.readFileSync(settingsPath(), "utf-8")) }; } catch { /* first run */ }
  if (!settings.outputRoot) settings.outputRoot = path.join(app.getPath("desktop"), "ImageRush");
  panelOpen = settings.panelOpen !== false;
}
async function saveSettings() {
  await fs.mkdir(path.dirname(settingsPath()), { recursive: true });
  await fs.writeFile(settingsPath(), JSON.stringify(settings, null, 2));
}

// ---------- window + embedded Meta AI panel ----------

function panelWidth() {
  if (!win || !panelOpen) return 0;
  const [w] = win.getContentSize();
  return Math.max(MIN_PANEL, Math.round(w * 0.42));
}

function layout() {
  if (!win || !metaView) return;
  const [w, h] = win.getContentSize();
  const pw = panelWidth();
  metaView.setBounds(pw ? { x: w - pw, y: 0, width: pw, height: h } : { x: w, y: 0, width: Math.max(MIN_PANEL, Math.round(w * 0.42)), height: h });
  metaView.setVisible(!!pw);
  win.webContents.send("panel:changed", { width: pw, open: panelOpen });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1500, height: 920, minWidth: 980, minHeight: 640,
    title: "ImageRush",
    icon: path.join(__dirname, "icons", "icon.png"),
    backgroundColor: "#0f1420",
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  win.removeMenu();

  metaView = new WebContentsView({ webPreferences: { partition: META_PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true } });
  win.contentView.addChildView(metaView);
  const wc = metaView.webContents;
  // A normal browser user agent, so meta.ai serves its regular web app.
  wc.setUserAgent(wc.getUserAgent().replace(/ Electron\/[\d.]+/, "").replace(/ imagerush\/[\d.]+/i, ""));
  // Facebook/Instagram login pop-ups must open inside the same session.
  wc.setWindowOpenHandler(() => ({ action: "allow", overrideBrowserWindowOptions: { webPreferences: { partition: META_PARTITION, sandbox: true }, parent: win, modal: false } }));
  wc.on("did-finish-load", () => { refreshStatus().catch(() => {}); });
  wc.on("did-navigate-in-page", () => { refreshStatus().catch(() => {}); });
  wc.loadURL(META_HOME);

  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\/(www\.)?meta\.ai\//.test(url)) { setPanel(true); return { action: "deny" }; }
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.on("resize", layout);
  win.webContents.on("did-finish-load", layout);
  win.on("closed", () => { win = null; metaView = null; });
}

function setPanel(open) {
  panelOpen = !!open;
  settings.panelOpen = panelOpen;
  saveSettings().catch(() => {});
  layout();
  if (panelOpen && metaView) metaView.webContents.focus();
}

function waitForLoad(wc, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    if (!wc.isLoading()) return resolve();
    const timer = setTimeout(() => reject(new Error("The meta.ai page took too long to load.")), timeoutMs);
    wc.once("did-finish-load", () => { clearTimeout(timer); resolve(); });
    wc.once("did-fail-load", (_e, code, desc) => { clearTimeout(timer); reject(new Error(`meta.ai did not load (${desc || code}). Check your internet connection.`)); });
  });
}

async function ensureAdapter(wc) {
  await wc.executeJavaScript(ADAPTER_SRC, true);
}

async function prepareMeta(newChat) {
  if (!metaView) throw new Error("The app window is closed.");
  const wc = metaView.webContents;
  if (wc.isLoading()) await waitForLoad(wc);
  if (!/^https:\/\/(www\.)?meta\.ai\//.test(wc.getURL())) {
    wc.loadURL(META_HOME);
    await waitForLoad(wc);
    await ensureAdapter(wc);
    return wc;
  }
  await ensureAdapter(wc);
  if (newChat) {
    const ok = await wc.executeJavaScript("window.__imagerush.newChat()", true).catch(() => false);
    if (!ok) {
      wc.loadURL(META_HOME);
      await waitForLoad(wc);
      await ensureAdapter(wc);
    }
  }
  return wc;
}

async function refreshStatus() {
  if (!metaView || !win) return null;
  const wc = metaView.webContents;
  if (wc.isLoading()) return lastStatus;
  try {
    await ensureAdapter(wc);
    const diag = await wc.executeJavaScript("window.__imagerush.diagnose()", true);
    lastStatus = { loggedIn: !!diag.loggedIn, ready: !!diag.composerFound, url: diag.url };
  } catch (exc) {
    lastStatus = { loggedIn: false, ready: false, error: exc.message };
  }
  win.webContents.send("meta:status", lastStatus);
  return lastStatus;
}

// ---------- IPC: meta.ai ----------

ipcMain.handle("meta:status", async () => (await refreshStatus()) || lastStatus || { loggedIn: false, ready: false });
ipcMain.handle("meta:diagnose", async () => { const wc = await prepareMeta(false); return wc.executeJavaScript("window.__imagerush.diagnose()", true); });
ipcMain.handle("meta:login", async () => {
  setPanel(true);
  const wc = metaView.webContents;
  if (!/^https:\/\/(www\.)?meta\.ai\//.test(wc.getURL()) || lastStatus?.loggedIn === false) wc.loadURL(META_HOME);
  return { ok: true };
});
ipcMain.handle("meta:logout", async () => {
  const ses = session.fromPartition(META_PARTITION);
  await ses.clearStorageData();
  metaView?.webContents.loadURL(META_HOME);
  return { ok: true };
});
ipcMain.handle("panel:set", async (_e, { open }) => { setPanel(open); return { open: panelOpen, width: panelWidth() }; });
ipcMain.handle("panel:get", async () => ({ open: panelOpen, width: panelWidth() }));

ipcMain.handle("meta:generate", async (_e, { prompt, timeoutMs = 180000, allVariants = false, newChat = true }) => {
  if (typeof prompt !== "string" || !prompt.trim()) throw new Error("Empty prompt.");
  if (!panelOpen) setPanel(true); // generation happens visibly in the panel
  const wc = await prepareMeta(newChat);
  const reply = await wc.executeJavaScript(
    `window.__imagerush.generate(${JSON.stringify({ prompt, timeoutMs: Math.min(Math.max(timeoutMs, 20000), 1800000), allVariants })})`, true);
  if (!reply || !reply.ok) return reply || { ok: false, retryable: true, error: "No reply from the meta.ai page." };
  const ses = session.fromPartition(META_PARTITION);
  const images = [];
  for (const img of reply.images) {
    const resp = await ses.fetch(img.url, { headers: { Referer: META_HOME } });
    if (!resp.ok) throw Object.assign(new Error(`Could not download the image (HTTP ${resp.status}).`), { retryable: true });
    const type = resp.headers.get("content-type") || "";
    const buf = Buffer.from(await resp.arrayBuffer());
    if (!type.startsWith("image/") || buf.length < 1000) throw Object.assign(new Error("Meta returned data that is not an image."), { retryable: true });
    images.push({ url: img.url, bytes: buf, mime: type, width: img.width, height: img.height });
  }
  return { ok: true, images };
});

// ---------- IPC: files ----------

function safeName(name) {
  return String(name).replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim().replace(/^[. ]+|[. ]+$/g, "").slice(0, 150) || "file";
}
async function uniquePath(dir, base, ext) {
  let candidate = path.join(dir, `${base}.${ext}`);
  let n = 1;
  while (fssync.existsSync(candidate)) candidate = path.join(dir, `${base} (${n++}).${ext}`);
  return candidate;
}

ipcMain.handle("fs:getRoot", async () => ({ root: settings.outputRoot }));
ipcMain.handle("fs:chooseRoot", async () => {
  const r = await dialog.showOpenDialog(win, { title: "Select the folder where ImageRush saves images", defaultPath: settings.outputRoot, buttonLabel: "Use this folder", properties: ["openDirectory", "createDirectory"] });
  if (r.canceled || !r.filePaths[0]) return { root: settings.outputRoot, changed: false };
  settings.outputRoot = r.filePaths[0];
  await saveSettings();
  return { root: settings.outputRoot, changed: true };
});
ipcMain.handle("fs:saveFile", async (_e, { folder, base, ext, bytes, overwrite = false, subfolder = "" }) => {
  const dir = path.join(settings.outputRoot, safeName(folder), subfolder ? safeName(subfolder) : "");
  await fs.mkdir(dir, { recursive: true });
  const target = overwrite ? path.join(dir, `${safeName(base)}.${ext}`) : await uniquePath(dir, safeName(base), ext);
  const data = Buffer.from(bytes);
  if (!data.length) throw new Error("Refusing to write an empty file.");
  await fs.writeFile(`${target}.part`, data);
  await fs.rename(`${target}.part`, target);
  const stat = await fs.stat(target);
  if (!(stat.size > 0)) throw new Error("The file was not written.");
  return { path: target, name: path.basename(target), size: stat.size };
});
ipcMain.handle("fs:openFolder", async (_e, { folder }) => {
  const dir = path.join(settings.outputRoot, folder ? safeName(folder) : "");
  await fs.mkdir(dir, { recursive: true });
  await shell.openPath(dir);
  return { ok: true };
});
ipcMain.handle("fs:readFiles", async (_e, { paths }) => {
  const out = [];
  for (const p of (paths || []).slice(0, 500)) {
    const stat = await fs.stat(p).catch(() => null);
    if (!stat) continue;
    if (stat.isDirectory()) {
      const entries = await fs.readdir(p, { withFileTypes: true });
      for (const ent of entries) if (ent.isFile() && /\.(json|txt|md)$/i.test(ent.name)) out.push({ name: `${path.basename(p)}/${ent.name}`, text: await fs.readFile(path.join(p, ent.name), "utf-8") });
    } else if (/\.(json|txt|md)$/i.test(p) && stat.size < 50 * 1024 * 1024) {
      out.push({ name: path.basename(p), text: await fs.readFile(p, "utf-8") });
    }
  }
  return out;
});

// ---------- IPC: AI prompt writing (through the website; no key in this app) ----------

ipcMain.handle("ai:available", async () => {
  try { const r = await net.fetch(AI_ENDPOINT, { method: "OPTIONS" }); return r.ok || r.status === 204; } catch { return false; }
});
ipcMain.handle("ai:prompts", async (_e, payload) => {
  const r = await net.fetch(AI_ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://bulk-meta-ai-image-generator-web.vercel.app" }, body: JSON.stringify(payload) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `AI request failed (${r.status}).`);
  return data;
});

ipcMain.handle("app:version", () => app.getVersion());

// ---------- lifecycle ----------

app.setAppUserModelId("ai.humynlabs.imagerush");
app.whenReady().then(() => {
  loadSettings();
  createWindow();
  if (process.env.IMAGERUSH_SMOKE) {
    win.webContents.once("did-finish-load", async () => {
      await sleep(4000);
      try {
        const info = await win.webContents.executeJavaScript(`({
          title: document.title,
          setupHidden: document.getElementById("setup-card").classList.contains("hidden"),
          bar: document.getElementById("desktop-bar")?.innerText.replace(/\\s+/g, " ").slice(0, 160),
          aiVisible: !document.querySelector("[data-mode=ai]").classList.contains("hidden"),
          composer: !!document.getElementById("cmp-send"),
          bodyMargin: getComputedStyle(document.body).marginRight,
        })`, true);
        console.log("SMOKE " + JSON.stringify(info));
        if (process.env.IMAGERUSH_SHOT) {
          const img = await win.webContents.capturePage();
          fssync.writeFileSync(path.join(process.env.IMAGERUSH_SHOT, "dashboard.png"), img.toPNG());
          const img2 = await metaView.webContents.capturePage();
          fssync.writeFileSync(path.join(process.env.IMAGERUSH_SHOT, "meta-panel.png"), img2.toPNG());
        }
        if (process.env.IMAGERUSH_SMOKE === "meta") console.log("SMOKE_META " + JSON.stringify(await refreshStatus()));
      } catch (exc) { console.log("SMOKE_ERROR " + exc.message); }
      app.exit(0);
    });
  }
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on("window-all-closed", () => app.quit());
