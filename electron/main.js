"use strict";

// Electron main process for Token Dashboard.
// Spawns the Python backend, waits for the ready signal, opens a
// BrowserWindow at the bound URL, owns the tray + SSE refresh loop, and
// tears the child process down on quit.

const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");

const { probeFreePort, spawnBackend, waitForReady, killBackend } = require("./src/backend");
const { createMainWindow, focusMain } = require("./src/window");
const { createTray } = require("./src/tray");
const { createSSEClient } = require("./src/sse-client");

const REPO_ROOT = path.resolve(__dirname, "..");
const PRELOAD_PATH = path.join(__dirname, "preload.js");
const IS_WIN = process.platform === "win32";
const IS_MAC = process.platform === "darwin";

let backendChild = null;
let backendUrl = null;
let mainWindow = null;
let tray = null;
let sse = null;
let lastReadyPayload = null;

ipcMain.handle("td:backend-url", () => backendUrl);
ipcMain.handle("td:ready-payload", () => lastReadyPayload);
ipcMain.handle("td:toggle-devtools", () => {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  const wc = mainWindow.webContents;
  if (wc.isDevToolsOpened()) {
    wc.closeDevTools();
    return false;
  }
  wc.openDevTools({ mode: "detach" });
  return true;
});

async function bootstrap() {
  let port = parseInt(process.env.PORT || "0", 10);
  if (!port) port = await probeFreePort();
  backendChild = spawnBackend({
    port,
    repoRoot: REPO_ROOT,
    isPackaged: app.isPackaged,
    isWin: IS_WIN,
    dirname: __dirname,
  });
  backendChild.on("exit", () => { backendChild = null; });
  try {
    const ready = await waitForReady(backendChild, port);
    backendUrl = ready.url;
    lastReadyPayload = ready.readyPayload;
  } catch (err) {
    console.error(err.message);
    app.quit();
    return;
  }

  mainWindow = createMainWindow({
    url: backendUrl,
    preloadPath: PRELOAD_PATH,
    isMac: IS_MAC,
    isWin: IS_WIN,
    devMode: process.argv.includes("--dev"),
  });

  tray = createTray({
    getMainWindow: () => mainWindow,
    getBackendUrl: () => backendUrl,
    focusMain,
    isMac: IS_MAC,
    isWin: IS_WIN,
  });

  if (mainWindow && mainWindow.webContents) {
    mainWindow.webContents.once("did-finish-load", () => tray.fetchAndApply());
  }

  sse = createSSEClient({
    getBackendUrl: () => backendUrl,
    onTick: () => tray.requestUpdate(),
  });
  sse.connect();
}

app.whenReady().then(bootstrap);

app.on("window-all-closed", () => {
  // On macOS, keep the app alive (tray-driven). Elsewhere, quit.
  if (!IS_MAC) app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0 && backendUrl) {
    mainWindow = createMainWindow({
      url: backendUrl,
      preloadPath: PRELOAD_PATH,
      isMac: IS_MAC,
      isWin: IS_WIN,
      devMode: process.argv.includes("--dev"),
    });
  }
});

app.on("before-quit", () => {
  if (sse) sse.stop();
  if (tray) tray.destroy();
  killBackend(backendChild);
  backendChild = null;
});

const onProcessExit = () => killBackend(backendChild);
process.on("exit", onProcessExit);
process.on("SIGINT", () => { onProcessExit(); process.exit(0); });
process.on("SIGTERM", () => { onProcessExit(); process.exit(0); });
