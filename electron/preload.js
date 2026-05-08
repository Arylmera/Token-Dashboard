"use strict";

// Preload script — exposes a tiny safe surface to the renderer.
// The renderer is the existing React app loaded from http://127.0.0.1:<port>/
// over the local backend. We only expose lookups it can't do via fetch alone
// (the bound URL itself, the ready-line payload).

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("td", {
  backendUrl: () => ipcRenderer.invoke("td:backend-url"),
  readyPayload: () => ipcRenderer.invoke("td:ready-payload"),
  toggleDevTools: () => ipcRenderer.invoke("td:toggle-devtools"),
  platform: process.platform,
});
