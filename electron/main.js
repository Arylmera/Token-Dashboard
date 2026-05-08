"use strict";

// Electron main process for Token Dashboard.
// Spawns the Python backend, waits for the TOKEN_DASHBOARD_READY stdout line
// (or polls /api/health as a fallback), opens a BrowserWindow at the bound URL,
// and tears the child down on app quit.

const { app, BrowserWindow, Tray, nativeImage, Menu, ipcMain, shell } = require("electron");
const { spawn } = require("child_process");
const http = require("http");
const net = require("net");
const path = require("path");
const fs = require("fs");

const { formatTokens, formatCostUSD } = require("../shared/format");

const READY_TOKEN = "TOKEN_DASHBOARD_READY";
const REPO_ROOT = path.resolve(__dirname, "..");
const IS_PACKAGED = app.isPackaged;
const IS_WIN = process.platform === "win32";
const IS_MAC = process.platform === "darwin";

const DISPLAY_THROTTLE_MS = 1000;          // 1 Hz cap on shell updates
const SSE_RECONNECT_MS = 2000;             // backoff for /api/stream

let backend = null;       // child process handle
let backendUrl = null;    // resolved http://host:port/
let mainWindow = null;
let tray = null;
let healthPollTimer = null;
let lastReadyPayload = null;
let sseRequest = null;
let displayTimer = null;
let displayPending = false;
let lastDisplay = { tokens: null, cost: null };

// ---------------------------------------------------------------- helpers

function probeFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen({ host: "127.0.0.1", port: 0 }, () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

function pythonCommand() {
  // Packaged app: prefer the bundled PyInstaller exe shipped in extraResources.
  if (IS_PACKAGED) {
    const resBase = process.resourcesPath || path.join(__dirname, "resources");
    const exeName = IS_WIN ? "token-dashboard.exe" : "token-dashboard";
    const bundled = path.join(resBase, "py", exeName);
    if (fs.existsSync(bundled)) {
      return { cmd: bundled, args: ["dashboard", "--no-open", "--no-scan"] };
    }
  }
  // Dev: probe the user's Python.
  const py = process.env.PYTHON || (IS_WIN ? "py" : "python3");
  const args = IS_WIN && py === "py"
    ? ["-3", "-m", "token_dashboard", "dashboard", "--no-open", "--no-scan"]
    : ["-m", "token_dashboard", "dashboard", "--no-open", "--no-scan"];
  return { cmd: py, args };
}

function spawnBackend(port) {
  const { cmd, args } = pythonCommand();
  const env = Object.assign({}, process.env, {
    HOST: "127.0.0.1",
    PORT: String(port),
    PYTHONUNBUFFERED: "1",
    PYTHONIOENCODING: "utf-8",
  });
  const child = spawn(cmd, args, {
    cwd: REPO_ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.on("error", (err) => {
    console.error("[backend] spawn error:", err);
  });
  child.on("exit", (code, signal) => {
    console.log(`[backend] exited code=${code} signal=${signal}`);
    backend = null;
  });
  return child;
}

function waitForReady(child, port, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let resolved = false;
    let buf = "";

    const onLine = (line) => {
      if (line.startsWith(READY_TOKEN)) {
        const jsonPart = line.slice(READY_TOKEN.length).trim();
        try { lastReadyPayload = JSON.parse(jsonPart); } catch (_) { lastReadyPayload = null; }
        if (!resolved) {
          resolved = true;
          resolve(`http://127.0.0.1:${port}/`);
        }
      } else if (line) {
        console.log(`[backend] ${line}`);
      }
    };

    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, "");
        buf = buf.slice(idx + 1);
        onLine(line);
      }
    });
    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", (chunk) => {
      process.stderr.write(`[backend:err] ${chunk}`);
    });

    // Fallback poll: hit /api/health in case stdout is detached.
    const startedAt = Date.now();
    const poll = () => {
      if (resolved) return;
      const req = http.get({ host: "127.0.0.1", port, path: "/api/health", timeout: 1500 }, (res) => {
        let body = "";
        res.on("data", (d) => { body += d; });
        res.on("end", () => {
          if (resolved) return;
          if (res.statusCode === 200) {
            try {
              const j = JSON.parse(body);
              if (j && j.ok) {
                resolved = true;
                resolve(`http://127.0.0.1:${port}/`);
                return;
              }
            } catch (_) {}
          }
          if (Date.now() - startedAt < timeoutMs) setTimeout(poll, 300);
        });
      });
      req.on("error", () => {
        if (Date.now() - startedAt < timeoutMs) setTimeout(poll, 300);
      });
      req.on("timeout", () => req.destroy());
    };
    setTimeout(poll, 600);

    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        reject(new Error(`Backend did not become ready within ${timeoutMs}ms`));
      }
    }, timeoutMs);
  });
}

function killBackend() {
  if (!backend) return;
  try {
    if (IS_WIN) {
      // detached child group is safest, but we didn't detach; SIGTERM is fine.
      backend.kill();
    } else {
      backend.kill("SIGTERM");
    }
  } catch (_) {}
  backend = null;
}

// ---------------------------------------------------------------- window

function createMainWindow(url) {
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
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  };
  if (IS_MAC) {
    // Keeps the macOS traffic-light buttons; frees the rest of the title bar.
    opts.titleBarStyle = "hiddenInset";
  } else if (IS_WIN) {
    // Native min/max/close buttons rendered by the OS; the rest of the title
    // strip is paintable by the app via -webkit-app-region: drag.
    opts.titleBarStyle = "hidden";
    opts.titleBarOverlay = { color: "#0a0a0a", symbolColor: "#ffffff", height: 32 };
  }
  const win = new BrowserWindow(opts);
  win.once("ready-to-show", () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("did-fail-load", (_e, code, desc, validatedUrl) => {
    console.error(`[renderer] did-fail-load ${code} ${desc} ${validatedUrl}`);
  });
  win.webContents.on("render-process-gone", (_e, details) => {
    console.error(`[renderer] gone:`, details);
  });
  win.webContents.on("console-message", (_e, level, message, line, source) => {
    const tag = ["DBG", "LOG", "WARN", "ERR"][level] || "LOG";
    console.log(`[renderer:${tag}] ${source}:${line} ${message}`);
  });
  if (process.argv.includes("--dev")) {
    win.webContents.openDevTools({ mode: "detach" });
  }
  win.loadURL(url);
  return win;
}

// ---------------------------------------------------------------- tray

function emptyTrayImage() {
  // 16x16 transparent PNG (template image) — content-free; macOS will tint.
  return nativeImage.createEmpty();
}

function ensureTray() {
  if (tray) return tray;
  tray = new Tray(emptyTrayImage());
  if (IS_MAC) {
    tray.setTitle("…");
  } else {
    tray.setToolTip("Token Dashboard — loading");
  }
  const menu = Menu.buildFromTemplate([
    { label: "Open Dashboard", click: () => focusMain() },
    { type: "separator" },
    { label: "Quit", click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
  tray.on("click", () => focusMain());
  return tray;
}

function focusMain() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

async function fetchOverviewToday() {
  if (!backendUrl) return null;
  // Today range = [today 00:00 UTC, tomorrow 00:00 UTC).
  const now = new Date();
  const startUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  const endUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString();
  const u = new URL("/api/overview", backendUrl);
  u.searchParams.set("since", startUtc);
  u.searchParams.set("until", endUtc);
  return new Promise((resolve) => {
    http.get(u.toString(), (res) => {
      let body = "";
      res.on("data", (d) => { body += d; });
      res.on("end", () => {
        try { resolve(JSON.parse(body)); } catch (_) { resolve(null); }
      });
    }).on("error", () => resolve(null));
  });
}

function billableTokens(o) {
  if (!o) return 0;
  return (o.input_tokens || 0) + (o.output_tokens || 0)
    + (o.cache_create_5m_tokens || 0) + (o.cache_create_1h_tokens || 0);
}

async function renderBadgePNG(text) {
  // Round-trip canvas rendering through the renderer's main world. Cheap
  // (~1ms) and avoids a native canvas dep. Returns a `data:image/png;base64,…`
  // URL; falls back to null if the renderer is gone.
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  const safe = String(text).replace(/[^\w.+\-]/g, "").slice(0, 6);
  const js = `(() => {
    const c = document.createElement('canvas');
    c.width = 32; c.height = 32;
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, 32, 32);
    ctx.beginPath();
    ctx.arc(16, 16, 15, 0, Math.PI * 2);
    ctx.fillStyle = '#0a0a0a';
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.font = '600 ' + (${safe.length} > 3 ? '11' : '14') + 'px Inter, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(${JSON.stringify(safe)}, 16, 17);
    return c.toDataURL('image/png');
  })()`;
  try {
    return await mainWindow.webContents.executeJavaScript(js, true);
  } catch (e) {
    console.warn("[badge] render failed:", e.message);
    return null;
  }
}

function applyDisplay(overview) {
  if (!tray) return;
  const tokens = billableTokens(overview);
  const cost = overview && typeof overview.cost_usd === "number" ? overview.cost_usd : null;
  const formattedTokens = formatTokens(tokens);
  const formattedCost = formatCostUSD(cost);

  if (lastDisplay.tokens === tokens && lastDisplay.cost === cost) return;
  lastDisplay = { tokens, cost };

  const tooltip = `Token Dashboard\nToday: ${formattedTokens} tokens · ${formattedCost}`;
  tray.setToolTip(tooltip);

  if (IS_MAC) {
    tray.setTitle(formattedTokens);
    if (app.dock && typeof app.dock.setBadge === "function") {
      app.dock.setBadge(tokens > 0 ? formattedTokens : "");
    }
  }

  if (IS_WIN && mainWindow && !mainWindow.isDestroyed()) {
    renderBadgePNG(formattedTokens).then((dataURL) => {
      if (!dataURL || mainWindow.isDestroyed()) return;
      const img = nativeImage.createFromDataURL(dataURL);
      try {
        mainWindow.setOverlayIcon(tokens > 0 ? img : null, `${formattedTokens} tokens today`);
      } catch (e) {
        console.warn("[overlay] setOverlayIcon failed:", e.message);
      }
    });
  }
}

async function fetchAndApplyDisplay() {
  const o = await fetchOverviewToday();
  applyDisplay(o);
}

function requestDisplayUpdate() {
  // Throttle to DISPLAY_THROTTLE_MS — coalesces SSE bursts.
  if (displayPending) return;
  displayPending = true;
  if (displayTimer) clearTimeout(displayTimer);
  displayTimer = setTimeout(async () => {
    displayPending = false;
    displayTimer = null;
    await fetchAndApplyDisplay();
  }, DISPLAY_THROTTLE_MS);
}

function subscribeSSE() {
  if (!backendUrl) return;
  const u = new URL("/api/stream", backendUrl);
  const req = http.get(
    { host: u.hostname, port: u.port, path: u.pathname, headers: { "Accept": "text/event-stream" } },
    (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        scheduleSSEReconnect();
        return;
      }
      res.setEncoding("utf-8");
      let buf = "";
      res.on("data", (chunk) => {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          if (frame.startsWith(":")) continue; // keep-alive ping
          // Each frame is `data: <json>` lines; we only emit single-line data.
          const line = frame.replace(/^data:\s*/, "").trim();
          if (!line) continue;
          requestDisplayUpdate();
        }
      });
      res.on("end", scheduleSSEReconnect);
      res.on("error", scheduleSSEReconnect);
    }
  );
  req.on("error", scheduleSSEReconnect);
  sseRequest = req;
}

function scheduleSSEReconnect() {
  if (sseRequest) {
    try { sseRequest.destroy(); } catch (_) {}
    sseRequest = null;
  }
  setTimeout(() => {
    if (backendUrl) subscribeSSE();
  }, SSE_RECONNECT_MS);
}

// ---------------------------------------------------------------- ipc

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

// ---------------------------------------------------------------- lifecycle

async function bootstrap() {
  let port = parseInt(process.env.PORT || "0", 10);
  if (!port) port = await probeFreePort();
  backend = spawnBackend(port);
  try {
    backendUrl = await waitForReady(backend, port);
  } catch (err) {
    console.error(err.message);
    app.quit();
    return;
  }
  mainWindow = createMainWindow(backendUrl);
  ensureTray();
  // Initial render once the renderer's DOM is ready (so canvas is available).
  if (mainWindow && mainWindow.webContents) {
    mainWindow.webContents.once("did-finish-load", () => {
      fetchAndApplyDisplay();
    });
  }
  subscribeSSE();
}

app.whenReady().then(bootstrap);

app.on("window-all-closed", () => {
  // On macOS, keep the app alive (tray-driven). Elsewhere, quit.
  if (!IS_MAC) app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0 && backendUrl) {
    mainWindow = createMainWindow(backendUrl);
  }
});

app.on("before-quit", () => {
  if (displayTimer) clearTimeout(displayTimer);
  if (healthPollTimer) clearInterval(healthPollTimer);
  if (sseRequest) { try { sseRequest.destroy(); } catch (_) {} sseRequest = null; }
  killBackend();
});

process.on("exit", killBackend);
process.on("SIGINT", () => { killBackend(); process.exit(0); });
process.on("SIGTERM", () => { killBackend(); process.exit(0); });
