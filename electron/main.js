"use strict";

// Electron main process for Token Dashboard.
// Spawns the Python backend, waits for the ready signal, opens a
// BrowserWindow at the bound URL, owns the tray + SSE refresh loop, and
// tears the child process down on quit.

const { app, BrowserWindow, ipcMain, net } = require("electron");
const path = require("path");

const { probeFreePort, spawnBackend, waitForReady, killBackend } = require("./src/backend");
const { createMainWindow, focusMain, applyGlass } = require("./src/window");
const { createTray } = require("./src/tray");
const { createSSEClient } = require("./src/sse-client");

function fetchPreferences(baseUrl) {
  return new Promise((resolve) => {
    try {
      const req = net.request(`${baseUrl}/api/preferences`);
      let body = "";
      req.on("response", (res) => {
        res.on("data", (chunk) => { body += chunk.toString(); });
        res.on("end", () => {
          try { resolve(JSON.parse(body) || {}); } catch (_) { resolve({}); }
        });
        res.on("error", () => resolve({}));
      });
      req.on("error", () => resolve({}));
      req.end();
    } catch (_) { resolve({}); }
  });
}

const REPO_ROOT = path.resolve(__dirname, "..");
const PRELOAD_PATH = path.join(__dirname, "preload.js");
const ICON_PATH = path.join(__dirname, "build-resources", "icon.png");
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
ipcMain.handle("td:set-glass", (_e, enabled) => {
  applyGlass(mainWindow, !!enabled, { isMac: IS_MAC, isWin: IS_WIN });
  return !!enabled;
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

  const prefs = await fetchPreferences(backendUrl);
  const glassEnabled = !!prefs.glass_enabled;

  mainWindow = createMainWindow({
    url: backendUrl,
    preloadPath: PRELOAD_PATH,
    iconPath: ICON_PATH,
    isMac: IS_MAC,
    isWin: IS_WIN,
    devMode: process.argv.includes("--dev"),
    glass: glassEnabled,
  });

  tray = createTray({
    getMainWindow: () => mainWindow,
    getBackendUrl: () => backendUrl,
    focusMain,
    iconPath: ICON_PATH,
    isMac: IS_MAC,
    isWin: IS_WIN,
  });

  if (mainWindow && mainWindow.webContents) {
    mainWindow.webContents.once("did-finish-load", () => tray.fetchAndApply());
  }

  sse = createSSEClient({
    getBackendUrl: () => backendUrl,
    onTick: (payload) => {
      if (payload && payload.type === "preferences") {
        if (payload.badge_metric) tray.setMetric(payload.badge_metric);
        if (typeof payload.badge_dock_enabled === "boolean") tray.setDockEnabled(payload.badge_dock_enabled);
        if (typeof payload.badge_menubar_enabled === "boolean") tray.setMenubarEnabled(payload.badge_menubar_enabled);
        if (typeof payload.badge_window_mode === "string") tray.setWindowMode(payload.badge_window_mode);
        if (typeof payload.glass_enabled === "boolean") {
          applyGlass(mainWindow, payload.glass_enabled, { isMac: IS_MAC, isWin: IS_WIN });
        }
        return;
      }
      tray.requestUpdate();
    },
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
      iconPath: ICON_PATH,
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
