"use strict";

// Tray + taskbar/dock badge controller. Owns its own throttled update loop
// so SSE bursts coalesce into one refresh per DISPLAY_THROTTLE_MS.

const { Tray, Menu, app, nativeImage } = require("electron");
const http = require("http");

const DISPLAY_THROTTLE_MS = 1000;

function stripTrailingZero(v) {
  return v.toFixed(1).replace(/\.0$/, "");
}

function formatTokens(n) {
  if (n == null || Number.isNaN(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return stripTrailingZero(n / 1_000_000) + "M";
  if (abs >= 1_000) return stripTrailingZero(n / 1_000) + "k";
  return String(Math.round(n));
}

function formatCostUSD(usd) {
  if (usd == null || Number.isNaN(usd)) return "—";
  if (usd >= 100) return `$${Math.round(usd)}`;
  if (usd >= 10) return `$${usd.toFixed(1)}`;
  return `$${usd.toFixed(2)}`;
}

function billableTokens(o) {
  if (!o) return 0;
  return (o.input_tokens || 0) + (o.output_tokens || 0)
    + (o.cache_create_5m_tokens || 0) + (o.cache_create_1h_tokens || 0);
}

function todayUtcRange() {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return { start: start.toISOString(), end: end.toISOString() };
}

function fetchOverviewToday(backendUrl) {
  if (!backendUrl) return Promise.resolve(null);
  const { start, end } = todayUtcRange();
  const u = new URL("/api/overview", backendUrl);
  u.searchParams.set("since", start);
  u.searchParams.set("until", end);
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

function renderBadgeJS(text) {
  // Round-trip canvas rendering through the renderer's main world. Cheap
  // (~1ms) and avoids a native canvas dep. Returns a `data:image/png;base64,…`
  // URL.
  const safe = String(text).replace(/[^\w.+\-]/g, "").slice(0, 6);
  return `(() => {
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
}

async function renderBadgePNG(win, text) {
  if (!win || win.isDestroyed()) return null;
  try {
    return await win.webContents.executeJavaScript(renderBadgeJS(text), true);
  } catch (e) {
    console.warn("[badge] render failed:", e.message);
    return null;
  }
}

function createTray({ getMainWindow, getBackendUrl, focusMain, isMac, isWin }) {
  const tray = new Tray(nativeImage.createEmpty());
  if (isMac) tray.setTitle("…");
  else tray.setToolTip("Token Dashboard — loading");
  const menu = Menu.buildFromTemplate([
    { label: "Open Dashboard", click: () => focusMain(getMainWindow()) },
    { type: "separator" },
    { label: "Quit", click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
  tray.on("click", () => focusMain(getMainWindow()));

  let lastDisplay = { tokens: null, cost: null };
  let displayTimer = null;
  let displayPending = false;

  async function applyDisplay(overview) {
    const tokens = billableTokens(overview);
    const cost = overview && typeof overview.cost_usd === "number" ? overview.cost_usd : null;
    if (lastDisplay.tokens === tokens && lastDisplay.cost === cost) return;
    lastDisplay = { tokens, cost };

    const formattedTokens = formatTokens(tokens);
    const formattedCost = formatCostUSD(cost);
    tray.setToolTip(`Token Dashboard\nToday: ${formattedTokens} tokens · ${formattedCost}`);

    if (isMac) {
      tray.setTitle(formattedTokens);
      if (app.dock && typeof app.dock.setBadge === "function") {
        app.dock.setBadge(tokens > 0 ? formattedTokens : "");
      }
    }

    const win = getMainWindow();
    if (isWin && win && !win.isDestroyed()) {
      const dataURL = await renderBadgePNG(win, formattedTokens);
      if (!dataURL || win.isDestroyed()) return;
      try {
        const img = nativeImage.createFromDataURL(dataURL);
        win.setOverlayIcon(tokens > 0 ? img : null, `${formattedTokens} tokens today`);
      } catch (e) {
        console.warn("[overlay] setOverlayIcon failed:", e.message);
      }
    }
  }

  async function fetchAndApply() {
    const overview = await fetchOverviewToday(getBackendUrl());
    await applyDisplay(overview);
  }

  function requestUpdate() {
    if (displayPending) return;
    displayPending = true;
    if (displayTimer) clearTimeout(displayTimer);
    displayTimer = setTimeout(async () => {
      displayPending = false;
      displayTimer = null;
      await fetchAndApply();
    }, DISPLAY_THROTTLE_MS);
  }

  function destroy() {
    if (displayTimer) clearTimeout(displayTimer);
    displayTimer = null;
  }

  return { fetchAndApply, requestUpdate, destroy };
}

module.exports = { createTray };
