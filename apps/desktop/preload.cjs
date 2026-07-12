const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("heiss", {
  farm: (args) => ipcRenderer.invoke("farm", args),
  openExternal: (url) => ipcRenderer.invoke("open-external", url),
});
