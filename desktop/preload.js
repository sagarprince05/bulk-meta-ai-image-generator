// Exposes a small, explicit API to the dashboard page. No Node access leaks into the page.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktop", {
  version: () => ipcRenderer.invoke("app:version"),
  meta: {
    status: () => ipcRenderer.invoke("meta:status"),
    diagnose: () => ipcRenderer.invoke("meta:diagnose"),
    login: () => ipcRenderer.invoke("meta:login"),
    logout: () => ipcRenderer.invoke("meta:logout"),
    show: () => ipcRenderer.invoke("panel:set", { open: true }),
    generate: (opts) => ipcRenderer.invoke("meta:generate", opts),
    onStatus: (fn) => { ipcRenderer.on("meta:status", (_e, s) => fn(s)); },
  },
  panel: {
    set: (open) => ipcRenderer.invoke("panel:set", { open }),
    get: () => ipcRenderer.invoke("panel:get"),
    onChange: (fn) => { ipcRenderer.on("panel:changed", (_e, p) => fn(p)); },
  },
  fs: {
    getRoot: () => ipcRenderer.invoke("fs:getRoot"),
    chooseRoot: () => ipcRenderer.invoke("fs:chooseRoot"),
    saveFile: (opts) => ipcRenderer.invoke("fs:saveFile", opts),
    openFolder: (folder) => ipcRenderer.invoke("fs:openFolder", { folder }),
    readFiles: (paths) => ipcRenderer.invoke("fs:readFiles", { paths }),
  },
  ai: {
    available: () => ipcRenderer.invoke("ai:available"),
    prompts: (payload) => ipcRenderer.invoke("ai:prompts", payload),
  },
});
