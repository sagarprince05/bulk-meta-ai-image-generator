// Talks to the browser extension that drives meta.ai. The website never touches meta.ai itself.
export const EXTENSION_ID = "dpbebhhioolcdpffimbegacinlfipeia";

export function extensionApiAvailable() {
  return typeof chrome !== "undefined" && !!chrome.runtime && typeof chrome.runtime.sendMessage === "function";
}

function send(msg, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    if (!extensionApiAvailable()) return reject(new Error("This browser cannot talk to extensions. Use Chrome, Brave or Edge."));
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; reject(new Error("The extension did not answer in time.")); } }, timeoutMs);
    try {
      chrome.runtime.sendMessage(EXTENSION_ID, msg, (reply) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (chrome.runtime.lastError) return reject(new Error(`Extension not reachable: ${chrome.runtime.lastError.message}`));
        if (!reply) return reject(new Error("Empty reply from the extension."));
        resolve(reply);
      });
    } catch (exc) {
      done = true;
      clearTimeout(timer);
      reject(new Error(`Extension not reachable: ${exc.message}`));
    }
  });
}

export async function pingExtension() {
  try {
    const r = await send({ type: "ping" }, 3000);
    return r.ok ? { installed: true, version: r.version } : { installed: false, error: r.error };
  } catch (exc) {
    return { installed: false, error: exc.message };
  }
}

export function diagnose() {
  return send({ type: "diagnose" }, 60000);
}

/** Returns {ok, images:[{dataUrl,url,ext,width,height,note}]} or {ok:false,error,retryable,loginRequired}. */
export function generateImage({ prompt, timeoutMs, wantFormat, allVariants, newChat }) {
  return send({ type: "generate", prompt, timeoutMs, wantFormat, allVariants, newChat }, timeoutMs + 90000);
}

/** Save a file through the extension into the browser's Downloads folder, keeping subfolders. */
export async function saveViaExtension({ filename, dataUrl, overwrite = false }) {
  const r = await send({ type: "save", filename, dataUrl, overwrite }, 180000);
  if (!r.ok) throw new Error(r.error || "The extension could not save the file.");
  return r;
}
