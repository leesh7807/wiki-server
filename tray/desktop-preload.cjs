const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("wikiDesktop", {
  health: () => ipcRenderer.invoke("desktop:health"),
  metrics: () => ipcRenderer.invoke("desktop:metrics"),
  job: (id) => ipcRenderer.invoke("desktop:job", id),
  submit: (command, content) => ipcRenderer.invoke("desktop:submit", { command, content }),
  cancel: (id) => ipcRenderer.invoke("desktop:cancel", id),
  openData: () => ipcRenderer.invoke("desktop:open-data"),
  openLogs: () => ipcRenderer.invoke("desktop:open-logs"),
  openWebClient: () => ipcRenderer.invoke("desktop:open-web-client"),
  copyGuide: () => ipcRenderer.invoke("desktop:copy-guide"),
  getAutoLaunch: () => ipcRenderer.invoke("desktop:get-auto-launch"),
  setAutoLaunch: (enabled) => ipcRenderer.invoke("desktop:set-auto-launch", enabled),
});
