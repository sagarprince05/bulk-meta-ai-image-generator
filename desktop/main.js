// ImageRush desktop: the dashboard window plus a built-in Meta AI window.
// Nothing here talks to any server except meta.ai (in the user's own session) and the
// ImageRush website's prompt-writing API (no credentials in this app).
const { app, BrowserWindow, ipcMain, dialog, shell, session, net } = require("electron");
const path = require("node:path");
const fs = require("node:fs/promises");
const fssync = require("node:fs");

const META_HOME = "https://www.meta.ai/";
const META_PARTITION = "persist:metaai";
const AI_ENDPOINT = "https://bulk-meta-ai-image-generator-web.vercel.app/api/prompts";
const ADAPTER_SRC = fssync.readFileSync(path.join(__dirname, "meta-adapter.js"), "utf-8");

let dashboard = null;
let metaWin = null;
let settings = { outputRoot: null };
const settingsPath = () => path.join(app.getPath("userData"), "settings.json");

function loadSettings() {
  try { settings = { ...settings, ...JSON.parse(fssync.readFileSync(settingsPath(), "utf-8")) }; } catch { /* first run */ }
  if (!settings.outputRoot) settings.outputRoot = path.join(app.getPath("desktop"), "ImageRush");
}
async function saveSettings() {
  await fs.mkdir(path.dirname(settingsPath()), { recursive: true });
  await fs.writeFile(settingsPath(), JSON.stringify(settings, null, 2));
}

// ---------- windows ----------

function createDashboard() {
  dashboard = new BrowserWindow({
    width: 1240, height: 900, minWidth: 820, minHeight: 600,
    title: "ImageRush",
    icon: path.join(__dirname, "icons", "icon.png"),
    backgroundColor: "#0f1420",
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  dashboard.removeMenu();
  dashboard.loadFile(path.join(__dirname, "renderer", "index.html"));
  dashboard.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\/(www\.)?meta\.ai\//.test(url)) { showMetaWindow(); return { action: "deny" }; }
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  dashboard.on("closed", () => { dashboard = null; if (metaWin) metaWin.close(); });
}

function ensureMetaWindow() {
  if (metaWin && !metaWin.isDestroyed()) return metaWin;
  metaWin = new BrowserWindow({
    width: 1100, height: 820, title: "Meta AI (ImageRush)",
    icon: path.join(__dirname, "icons", "icon.png"),
    webPreferences: { partition: META_PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  metaWin.removeMenu();
  // A normal browser user agent, so meta.ai serves its regular web app.
  const ua = metaWin.webContents.getUserAgent().replace(/ Electron\/[\d.]+/, "").replace(/ imagerush\/[\d.]+/i, "");
  metaWin.webContents.setUserAgent(ua);
  metaWin.webContents.setWindowOpenHandler(({ url }) => {
    // Facebook/Instagram login pop-ups must open inside the same session.
    return { action: "allow", overrideBrowserWindowOptions: { webPreferences: { partition: META_PARTITION, sandbox: true } } };
  });
  metaWin.on("closed", () => { metaWin = null; });
  metaWin.loadURL(META_HOME);
  return metaWin;
}

function showMetaWindow() {
  const w = ensureMetaWindow();
  if (w.isMinimized()) w.restore();
  w.show();
  w.focus();
}

function waitForLoad(win, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    if (!win.webContents.isLoading()) return resolve();
    const timer = setTimeout(() => reject(new Error("The meta.ai page took too long to load.")), timeoutMs);
    win.webContents.once("did-finish-load", () => { clearTimeout(timer); resolve(); });
    win.webContents.once("did-fail-load", (_e, code, desc) => { clearTimeout(timer); reject(new Error(`meta.ai did not load (${desc || code}). Check your internet connection.`)); });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function prepareMeta(newChat) {
  const win = ensureMetaWindow();
  const url = win.webContents.getURL();
  if (newChat || !/^https:\/\/(www\.)?meta\.ai\//.test(url)) {
    win.loadURL(META_HOME);
    await waitForLoad(win);
    await sleep(1500);
  } else if (win.webContents.isLoading()) {
    await waitForLoad(win);
  }
  await win.webContents.executeJavaScript(ADAPTER_SRC, true);
  return win;
}

// ---------- IPC: meta.ai ----------

ipcMain.handle("meta:diagnose", async () => {
  const win = await prepareMeta(false);
  return win.webContents.executeJavaScript("window.__imagerush.diagnose()", true);
});

ipcMain.handle("meta:show", async () => { showMetaWindow(); return { ok: true }; });

ipcMain.handle("meta:generate", async (_e, { prompt, timeoutMs = 180000, allVariants = false, newChat = true }) => {
  if (typeof prompt !== "string" || !prompt.trim()) throw new Error("Empty prompt.");
  const win = await prepareMeta(newChat);
  const reply = await win.webContents.executeJavaScript(
    `window.__imagerush.generate(${JSON.stringify({ prompt, timeoutMs: Math.min(Math.max(timeoutMs, 20000), 1800000), allVariants })})`, true);
  if (!reply || !reply.ok) return reply || { ok: false, retryable: true, error: "No reply from the meta.ai page." };
  // Fetch the image bytes with the meta.ai session (cookies/referrer), outside the page's CORS rules.
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
  const r = await dialog.showOpenDialog(dashboard, { title: "Choose where ImageRush saves images", defaultPath: settings.outputRoot, properties: ["openDirectory", "createDirectory"] });
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
  createDashboard();
  if (process.env.IMAGERUSH_SMOKE) {
    // Automated check: boot the dashboard, read its setup status, then quit.
    dashboard.webContents.once("did-finish-load", async () => {
      await sleep(2500);
      try {
        const info = await dashboard.webContents.executeJavaScript(`({
          title: document.title,
          ext: document.getElementById("ext-status").textContent,
          dir: document.getElementById("dir-status").textContent,
          aiVisible: !document.querySelector("[data-mode=ai]").classList.contains("hidden"),
          composer: !!document.getElementById("cmp-send"),
          openMeta: !document.getElementById("btn-open-meta").classList.contains("hidden"),
          desktopApi: typeof window.desktop,
        })`, true);
        console.log("SMOKE " + JSON.stringify(info));
        if (process.env.IMAGERUSH_SMOKE === "meta") {
          const diag = await dashboard.webContents.executeJavaScript("window.desktop.meta.diagnose()", true);
          console.log("SMOKE_META " + JSON.stringify(diag));
        }
      } catch (exc) { console.log("SMOKE_ERROR " + exc.message); }
      app.exit(0);
    });
  }
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createDashboard(); });
});
app.on("window-all-closed", () => app.quit());
