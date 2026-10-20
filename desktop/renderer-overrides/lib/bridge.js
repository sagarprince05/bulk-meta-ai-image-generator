// Desktop build: talks to the built-in Meta AI window through the preload API instead of an extension.
const d = () => window.desktop;

export const EXTENSION_ID = "built-in";
export function extensionApiAvailable() { return !!d(); }

export async function pingExtension() {
  if (!d()) return { installed: false, error: "Desktop bridge missing." };
  return { installed: true, version: await d().version() };
}

export function diagnose() { return d().meta.diagnose(); }

/** Same shape as the extension bridge: images carry bytes instead of a data URL. */
export async function generateImage({ prompt, timeoutMs, wantFormat, allVariants, newChat }) {
  const r = await d().meta.generate({ prompt, timeoutMs, allVariants, newChat });
  if (!r.ok) return r;
  const images = [];
  for (const img of r.images) {
    let blob = new Blob([img.bytes], { type: img.mime });
    let ext = img.mime.replace("image/", "").replace("jpeg", "jpg") || "jpg";
    if (wantFormat === "png" && img.mime !== "image/png") {
      try { blob = await toPngBlob(blob); ext = "png"; } catch { /* keep original format */ }
    }
    images.push({ url: img.url, blob, ext, width: img.width, height: img.height });
  }
  return { ok: true, images };
}

async function toPngBlob(blob) {
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  canvas.getContext("2d").drawImage(bitmap, 0, 0);
  bitmap.close?.();
  return canvas.convertToBlob({ type: "image/png" });
}

export async function saveViaExtension() { throw new Error("Not used in the desktop build."); }
