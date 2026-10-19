// A small in-memory stand-in for the Chrome extension APIs the background worker uses.
// Downloads are written to a real temporary folder so file naming and existence can be checked.
import { mkdirSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join, dirname, extname, basename } from "node:path";

export function makeFakeChrome({ downloadDir, generateImpl }) {
  const listeners = (name) => {
    const fns = new Set();
    return { addListener: (f) => fns.add(f), removeListener: (f) => fns.delete(f), hasListener: (f) => fns.has(f), fire: (...a) => [...fns].forEach((f) => f(...a)), _name: name };
  };
  const storage = {};
  const downloads = [];
  let nextDownloadId = 1;
  let nextTabId = 100;
  const tabs = [];
  const runtimeMessage = listeners("runtime.onMessage");
  const chrome = {
    runtime: {
      lastError: undefined,
      onMessage: runtimeMessage,
      onMessageExternal: listeners("runtime.onMessageExternal"),
      getManifest: () => ({ version: "1.1.0" }),
      onConnect: listeners("runtime.onConnect"),
      onInstalled: listeners("runtime.onInstalled"),
      onStartup: listeners("runtime.onStartup"),
      getURL: (p) => `chrome-extension://fake/${p}`,
      sendMessage: async () => { throw new Error("no receiver"); }, // dashboard not open in tests
    },
    storage: {
      local: {
        get: async (keys) => {
          const out = {};
          for (const k of Array.isArray(keys) ? keys : [keys]) if (k in storage) out[k] = structuredClone(storage[k]);
          return out;
        },
        set: async (obj) => { for (const [k, v] of Object.entries(obj)) storage[k] = structuredClone(v); },
      },
    },
    alarms: { create: () => {}, onAlarm: listeners("alarms.onAlarm") },
    action: { onClicked: listeners("action.onClicked") },
    windows: { update: async () => {} },
    scripting: { executeScript: async () => {} },
    tabs: {
      onUpdated: listeners("tabs.onUpdated"),
      query: async ({ url }) => {
        if (!url) return tabs;
        const pats = (Array.isArray(url) ? url : [url]).map((p) => new RegExp("^" + p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")));
        return tabs.filter((t) => pats.some((re) => re.test(t.url)));
      },
      create: async ({ url }) => { const t = { id: nextTabId++, url, status: "complete", windowId: 1 }; tabs.push(t); return t; },
      update: async (id, { url }) => { const t = tabs.find((x) => x.id === id); if (url) { t.url = url; t.status = "complete"; } return t; },
      get: async (id) => tabs.find((x) => x.id === id),
      sendMessage: async (tabId, msg) => {
        if (msg.type === "ping") return { ok: true };
        if (msg.type === "generate") return generateImpl(msg, tabId);
        if (msg.type === "diagnose") return { ok: true, loggedIn: true, composerFound: true };
        return undefined;
      },
    },
    downloads: {
      onChanged: listeners("downloads.onChanged"),
      download: (opts, cb) => {
        const id = nextDownloadId++;
        const rel = opts.filename.replace(/\//g, "/");
        let target = join(downloadDir, rel);
        if (opts.conflictAction === "uniquify") {
          let n = 1;
          const ext = extname(target);
          const stem = target.slice(0, target.length - ext.length);
          while (existsSync(target)) target = `${stem} (${n++})${ext}`;
        }
        mkdirSync(dirname(target), { recursive: true });
        let bytes;
        const m = /^data:([^,]*?)(;base64)?,(.*)$/s.exec(opts.url);
        if (m) bytes = m[2] ? Buffer.from(m[3], "base64") : Buffer.from(decodeURIComponent(m[3]), "utf-8");
        else bytes = Buffer.from(`fake download of ${opts.url}`);
        const rec = { id, filename: target, url: opts.url, state: "in_progress", fileSize: 0, exists: true, error: undefined };
        downloads.push(rec);
        cb(id);
        setTimeout(() => {
          if (chrome.downloads._failNext) { chrome.downloads._failNext = false; rec.state = "interrupted"; rec.error = "FILE_FAILED"; }
          else { writeFileSync(target, bytes); rec.state = "complete"; rec.fileSize = statSync(target).size; }
          chrome.downloads.onChanged.fire({ id, state: { current: rec.state } });
        }, 5);
      },
      search: (q, cb) => cb(downloads.filter((d) => (q.id ? d.id === q.id : true) && (q.filenameRegex ? new RegExp(q.filenameRegex).test(d.filename) : true))),
      show: () => {},
      showDefaultFolder: () => {},
      setUiOptions: async () => {},
      _failNext: false,
    },
    _storage: storage,
    _downloads: downloads,
    _tabs: tabs,
  };
  return chrome;
}

/** Call a background message handler the way the dashboard would. */
export function callHandler(chrome, msg) {
  return new Promise((resolve) => {
    const fns = [];
    chrome.runtime.onMessage.addListener = (f) => fns.push(f);
    // The listener was registered at import time; find it by firing with a capturing sendResponse.
    chrome.runtime.onMessage.fire(msg, {}, resolve);
  });
}

export function tinyPngDataUrl() {
  // 1x1 transparent PNG
  return "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
}

export { basename };
