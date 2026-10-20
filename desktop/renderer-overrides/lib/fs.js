// Desktop build: files are written by the main process into the chosen output folder.
import { projectFolderName } from "./validation.js";
const d = () => window.desktop;

export function folderPickerSupported() { return true; }
export async function pickRootFolder() { const r = await d().fs.chooseRoot(); return { name: r.root, path: r.root }; }
export async function forgetRootFolder() { /* the desktop app always has a folder */ }
export async function loadRootFolder() { const r = await d().fs.getRoot(); return { handle: { name: r.root, path: r.root }, permission: "granted" }; }
export async function ensurePermission() { return true; }

export function dataUrlToBlob(dataUrl) {
  const [head, body] = dataUrl.split(",");
  const mime = /data:([^;]+)/.exec(head)?.[1] || "application/octet-stream";
  const bin = atob(body);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

export async function verifyImageBlob(blob) {
  const bitmap = await createImageBitmap(blob);
  const size = { width: bitmap.width, height: bitmap.height };
  bitmap.close?.();
  if (!size.width || !size.height) throw new Error("image has no pixels");
  return size;
}

/** Convert any decodable image blob to PNG in the renderer (Chromium decodes WebP/JPEG). */
export async function toPngBlob(blob) {
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  canvas.getContext("2d").drawImage(bitmap, 0, 0);
  bitmap.close?.();
  return canvas.convertToBlob({ type: "image/png" });
}

export class ProjectWriter {
  constructor(rootHandle, project) {
    this.root = rootHandle;
    this.folderName = projectFolderName(project.name);
  }
  get displayPath() { return `${this.root?.path || this.root?.name || "ImageRush"}\\${this.folderName}\\`; }
  async ensure() {}
  async saveImage(base, ext, blob) {
    const r = await d().fs.saveFile({ folder: this.folderName, base, ext, bytes: new Uint8Array(await blob.arrayBuffer()) });
    return { path: r.path, name: r.name, size: r.size };
  }
  async savePromptCopy(stem, text) {
    const r = await d().fs.saveFile({ folder: this.folderName, subfolder: "prompts", base: stem, ext: "txt", bytes: new TextEncoder().encode(text) });
    return r.path;
  }
  async writeJson(name, obj, { overwrite = true } = {}) {
    const r = await d().fs.saveFile({ folder: this.folderName, base: name.replace(/\.json$/, ""), ext: "json", bytes: new TextEncoder().encode(JSON.stringify(obj, null, 2)), overwrite });
    return r.path;
  }
}

export function downloadBlob(blob, filename) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
