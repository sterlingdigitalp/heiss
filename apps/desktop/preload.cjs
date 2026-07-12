const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("heiss", {
  farm: (args) => ipcRenderer.invoke("farm", args),
  daemonStart: () => ipcRenderer.invoke("daemon-start"),
  daemonStop: () => ipcRenderer.invoke("daemon-stop"),
  daemonStatus: () => ipcRenderer.invoke("daemon-status"),
  qrCode: (value) => ipcRenderer.invoke("qr-code", value),
  loginItemGet: () => ipcRenderer.invoke("login-item-get"),
  loginItemSet: (enabled) => ipcRenderer.invoke("login-item-set", enabled),
  openExternal: (url) => ipcRenderer.invoke("open-external", url),
});
