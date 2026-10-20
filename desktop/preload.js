// Exposes a small, explicit API to the dashboard page. No Node access leaks into the page.
const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("desktop", {
  version: () => ipcRenderer.invoke("app:version"),
  meta: {
    diagnose: () => ipcRenderer.invoke("meta:diagnose"),
    show: () => ipcRenderer.invoke("meta:show"),
    generate: (opts) => ipcRenderer.invoke("meta:generate", opts),
  },
  fs: {
    getRoot: () => ipcRenderer.invoke("fs:getRoot"),
    chooseRoot: () => ipcRenderer.invoke("fs:chooseRoot"),
    saveFile: (opts) => ipcRenderer.invoke("fs:saveFile", opts),
    openFolder: (folder) => ipcRenderer.invoke("fs:openFolder", { folder }),
    readFiles: (paths) => ipcRenderer.invoke("fs:readFiles", { paths }),
    pathOf: (file) => { try { return webUtils.getPathForFile(file); } catch { return null; } },
  },
  ai: {
    available: () => ipcRenderer.invoke("ai:available"),
    prompts: (payload) => ipcRenderer.invoke("ai:prompts", payload),
  },
});
