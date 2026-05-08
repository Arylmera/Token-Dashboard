"use strict";

const { BrowserWindow, shell } = require("electron");
const path = require("path");

function createMainWindow({ url, preloadPath, isMac, isWin, devMode }) {
  const opts = {
    width: 1280,
    height: 800,
    // Allow shrinking down to the CSS widget breakpoint (380px) so users can
    // dock the dashboard as a side widget. The renderer already collapses to
    // a single-column layout below 380px.
    minWidth: 280,
    minHeight: 200,
    backgroundColor: "#0a0a0a",
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  };
  if (isMac) {
    // Keeps the macOS traffic-light buttons; frees the rest of the title bar.
    opts.titleBarStyle = "hiddenInset";
  } else if (isWin) {
    // Native min/max/close buttons rendered by the OS; the rest of the title
    // strip is paintable by the app via -webkit-app-region: drag.
    opts.titleBarStyle = "hidden";
    opts.titleBarOverlay = { color: "#0a0a0a", symbolColor: "#ffffff", height: 32 };
  }
  const win = new BrowserWindow(opts);
  win.once("ready-to-show", () => win.show());
  win.webContents.setWindowOpenHandler(({ url: openUrl }) => {
    shell.openExternal(openUrl);
    return { action: "deny" };
  });
  win.webContents.on("did-fail-load", (_e, code, desc, validatedUrl) => {
    console.error(`[renderer] did-fail-load ${code} ${desc} ${validatedUrl}`);
  });
  win.webContents.on("render-process-gone", (_e, details) => {
    console.error("[renderer] gone:", details);
  });
  win.webContents.on("console-message", (_e, level, message, line, source) => {
    const tag = ["DBG", "LOG", "WARN", "ERR"][level] || "LOG";
    console.log(`[renderer:${tag}] ${source}:${line} ${message}`);
  });
  if (devMode) win.webContents.openDevTools({ mode: "detach" });
  win.loadURL(url);
  return win;
}

function focusMain(win) {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

module.exports = { createMainWindow, focusMain };
