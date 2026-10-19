// Saves files into a folder the user picked (File System Access API), or falls back to plain downloads.
import { projectFolderName } from "./validation.js";
import { saveViaExtension } from "./bridge.js";

export const DOWNLOAD_ROOT = "Generated_Images";

const DB_NAME = "bulkgen";
const STORE = "handles";

export function folderPickerSupported() {
  return typeof window !== "undefined" && typeof window.showDirectoryPicker === "function";
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function pickRootFolder() {
  const handle = await window.showDirectoryPicker({ id: "bulkgen-output", mode: "readwrite", startIn: "desktop" });
  await idbSet("root", handle);
  return handle;
}

export async function forgetRootFolder() {
  await idbSet("root", null);
}

/** Returns the saved handle, and whether we currently have write permission (may need a click to re-grant). */
export async function loadRootFolder() {
  const handle = await idbGet("root");
  if (!handle) return { handle: null, permission: "none" };
  const permission = await handle.queryPermission({ mode: "readwrite" });
  return { handle, permission };
}

export async function ensurePermission(handle) {
  if ((await handle.queryPermission({ mode: "readwrite" })) === "granted") return true;
  return (await handle.requestPermission({ mode: "readwrite" })) === "granted";
}

async function exists(dir, name) {
  try { await dir.getFileHandle(name); return true; } catch { /* not a file */ }
  try { await dir.getDirectoryHandle(name); return true; } catch { return false; }
}

export async function uniqueName(dir, base, ext) {
  let name = `${base}.${ext}`;
  let n = 1;
  while (await exists(dir, name)) name = `${base} (${n++}).${ext}`;
  return name;
}

async function writeFile(dir, name, data) {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(data);
  await w.close();
  const file = await (await dir.getFileHandle(name)).getFile();
  if (!(file.size > 0)) throw new Error(`${name} was written empty`);
  return file.size;
}

export function dataUrlToBlob(dataUrl) {
  const [head, body] = dataUrl.split(",");
  const mime = /data:([^;]+)/.exec(head)?.[1] || "application/octet-stream";
  if (/;base64/.test(head)) {
    const bin = atob(body);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }
  return new Blob([decodeURIComponent(body)], { type: mime });
}

/** Verify the bytes decode as an image and report its size. */
export async function verifyImageBlob(blob) {
  const bitmap = await createImageBitmap(blob);
  const size = { width: bitmap.width, height: bitmap.height };
  bitmap.close?.();
  if (!size.width || !size.height) throw new Error("image has no pixels");
  return size;
}

export class ProjectWriter {
  constructor(rootHandle, project) {
    this.root = rootHandle; // null => download fallback
    this.folderName = projectFolderName(project.name);
    this.dir = null;
  }

  get displayPath() {
    return this.root ? `${this.root.name}/${this.folderName}/` : `Downloads/${DOWNLOAD_ROOT}/${this.folderName}/`;
  }

  get relativeFolder() {
    return `${DOWNLOAD_ROOT}/${this.folderName}`;
  }

  async ensure() {
    if (this.root && !this.dir) this.dir = await this.root.getDirectoryHandle(this.folderName, { create: true });
  }

  /** Returns {path,size}; never overwrites. */
  async saveImage(base, ext, blob) {
    await this.ensure();
    if (this.dir) {
      const name = await uniqueName(this.dir, base, ext);
      const size = await writeFile(this.dir, name, blob);
      return { path: `${this.displayPath}${name}`, name, size };
    }
    // No folder chosen: ask the extension to download into Downloads/<root>/<project>/ (never overwrites).
    const r = await saveViaExtension({ filename: `${this.relativeFolder}/${base}.${ext}`, dataUrl: await blobToDataUrl(blob) });
    const name = r.path.split(/[\/]/).pop();
    return { path: r.path, name, size: r.size };
  }

  async savePromptCopy(stem, text) {
    await this.ensure();
    if (!this.dir) {
      const r = await saveViaExtension({ filename: `${this.relativeFolder}/prompts/${stem}.txt`, dataUrl: `data:text/plain;charset=utf-8,${encodeURIComponent(text)}` });
      return r.path;
    }
    const sub = await this.dir.getDirectoryHandle("prompts", { create: true });
    const name = await uniqueName(sub, stem, "txt");
    await writeFile(sub, name, new Blob([text], { type: "text/plain" }));
    return `${this.displayPath}prompts/${name}`;
  }

  async writeJson(name, obj, { overwrite = true } = {}) {
    await this.ensure();
    const text = JSON.stringify(obj, null, 2);
    if (this.dir) {
      const target = overwrite ? name : await uniqueName(this.dir, name.replace(/\.json$/, ""), "json");
      await writeFile(this.dir, target, new Blob([text], { type: "application/json" }));
      return `${this.displayPath}${target}`;
    }
    const r = await saveViaExtension({ filename: `${this.relativeFolder}/${name}`, dataUrl: `data:application/json;charset=utf-8,${encodeURIComponent(text)}`, overwrite });
    return r.path;
  }
}

export function downloadBlob(blob, filename) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename.replace(/\//g, "_"); // browsers flatten paths in plain downloads
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

export function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
