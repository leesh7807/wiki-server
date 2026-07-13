const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("wikiTray", {
  getSettings: () => ipcRenderer.invoke("settings:get"),
  setAutoLaunch: (enabled) => ipcRenderer.invoke("settings:set-auto-launch", enabled),
  openClient: () => ipcRenderer.invoke("settings:open-client"),
  openHealth: () => ipcRenderer.invoke("settings:open-health"),
  openLogs: () => ipcRenderer.invoke("settings:open-logs"),
  openData: () => ipcRenderer.invoke("settings:open-data"),
});
