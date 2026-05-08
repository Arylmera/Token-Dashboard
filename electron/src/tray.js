"use strict";

// Tray + taskbar/dock badge controller. Owns its own throttled update loop
// so SSE bursts coalesce into one refresh per DISPLAY_THROTTLE_MS. The
// metric shown is picked by the user in Settings → Status indicator and
// persisted on the backend via /api/preferences.

const { Tray, Menu, app, nativeImage } = require("electron");
const http = require("http");

const DISPLAY_THROTTLE_MS = 1000;
const VALID_METRICS = ["tokens", "cost", "burn", "5h", "weekly"];
const DEFAULT_METRIC = "tokens";
const VALID_WINDOW_MODES = ["remaining", "used"];
const DEFAULT_WINDOW_MODE = "remaining";

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

function formatBurnRate(usdPerHr) {
  if (usdPerHr == null || Number.isNaN(usdPerHr)) return "—";
  const v = usdPerHr;
  if (v >= 100) return `$${Math.round(v)}/h`;
  if (v >= 10) return `$${v.toFixed(1)}/h`;
  return `$${v.toFixed(2)}/h`;
}

function formatPctRemaining(pctRemaining, prefix) {
  if (pctRemaining == null || Number.isNaN(pctRemaining)) return "—";
  return `${prefix}${Math.round(pctRemaining * 100)}%`;
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

function fetchJSON(backendUrl, path, params) {
  if (!backendUrl) return Promise.resolve(null);
  const u = new URL(path, backendUrl);
  if (params) for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
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

function fetchOverviewToday(backendUrl) {
  const { start, end } = todayUtcRange();
  return fetchJSON(backendUrl, "/api/overview", { since: start, until: end });
}

function fetchHourlyLastHour(backendUrl) {
  return fetchJSON(backendUrl, "/api/hourly", { hours: "1" });
}

function fetchLimits(backendUrl) {
  return fetchJSON(backendUrl, "/api/limits");
}

function fetchPreferences(backendUrl) {
  return fetchJSON(backendUrl, "/api/preferences");
}

function lastHourCost(hourly) {
  if (!Array.isArray(hourly) || hourly.length === 0) return null;
  const last = hourly[hourly.length - 1];
  return last && typeof last.cost_usd === "number" ? last.cost_usd : 0;
}

function buildDisplay(metric, windowMode, { overview, hourly, limits }) {
  if (metric === "cost") {
    const usd = overview && typeof overview.cost_usd === "number" ? overview.cost_usd : 0;
    return {
      short: formatCostUSD(usd),
      tooltip: `Today: ${formatCostUSD(usd)}`,
      hasValue: usd > 0,
    };
  }
  if (metric === "burn") {
    const usdH = lastHourCost(hourly);
    return {
      short: formatBurnRate(usdH),
      tooltip: `Burn rate: ${formatBurnRate(usdH)} (last hour)`,
      hasValue: usdH != null && usdH > 0,
    };
  }
  if (metric === "5h" || metric === "weekly") {
    const win = limits && (metric === "5h" ? limits.five_hour : limits.weekly);
    const windowName = metric === "5h" ? "5h" : "Weekly";
    if (!win || win.cap == null) {
      return {
        short: "—",
        tooltip: `${windowName} window: no cap on ${(limits && limits.plan) || "current"} plan`,
        hasValue: false,
      };
    }
    const useUsed = windowMode === "used";
    const pct = useUsed ? win.pct_used : win.pct_remaining;
    const short = formatPctRemaining(pct, "");
    const sideLabel = useUsed ? "used" : "left";
    return {
      short,
      tooltip: `${windowName} window: ${Math.round((pct || 0) * 100)}% ${sideLabel} (${formatTokens(useUsed ? win.used : win.remaining)} of ${formatTokens(win.cap)} tok)`,
      hasValue: true,
    };
  }
  // tokens (default)
  const tokens = billableTokens(overview);
  return {
    short: formatTokens(tokens),
    tooltip: `Today: ${formatTokens(tokens)} tokens`,
    hasValue: tokens > 0,
  };
}

function renderBadgeJS(text) {
  // Round-trip canvas rendering through the renderer's main world. Cheap
  // (~1ms) and avoids a native canvas dep. Returns a `data:image/png;base64,…`
  // URL.
  const safe = String(text).replace(/[^\w.+\-$%/: ]/g, "").slice(0, 8);
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
    ctx.font = '600 ' + (${safe.length} > 4 ? '9' : (${safe.length} > 3 ? '11' : '14')) + 'px Inter, system-ui, sans-serif';
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

function createTray({ getMainWindow, getBackendUrl, focusMain, iconPath, isMac, isWin }) {
  // 16x16 logical (32x32 retina) is the standard menu-bar / tray icon size.
  let trayImage = nativeImage.createEmpty();
  if (iconPath) {
    try {
      const img = nativeImage.createFromPath(iconPath);
      if (!img.isEmpty()) trayImage = img.resize({ width: 16, height: 16 });
    } catch (e) {
      console.warn("[tray] icon load failed:", e.message);
    }
  }
  const tray = new Tray(trayImage);
  if (isMac) tray.setTitle("…");
  else tray.setToolTip("Token Dashboard — loading");
  const menu = Menu.buildFromTemplate([
    { label: "Open Dashboard", click: () => focusMain(getMainWindow()) },
    { type: "separator" },
    { label: "Quit", click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
  tray.on("click", () => focusMain(getMainWindow()));

  let metric = DEFAULT_METRIC;
  let windowMode = DEFAULT_WINDOW_MODE;
  let dockEnabled = true;
  let menubarEnabled = true;
  let lastShort = null;
  let displayTimer = null;
  let displayPending = false;

  function setMetric(next) {
    if (typeof next === "string" && VALID_METRICS.includes(next)) {
      if (metric !== next) {
        metric = next;
        lastShort = null;
        requestUpdate();
      }
    }
  }

  function setDockEnabled(next) {
    const v = !!next;
    if (dockEnabled === v) return;
    dockEnabled = v;
    lastShort = null;
    requestUpdate();
  }

  function setMenubarEnabled(next) {
    const v = !!next;
    if (menubarEnabled === v) return;
    menubarEnabled = v;
    lastShort = null;
    requestUpdate();
  }

  function setWindowMode(next) {
    if (typeof next === "string" && VALID_WINDOW_MODES.includes(next) && windowMode !== next) {
      windowMode = next;
      lastShort = null;
      requestUpdate();
    }
  }

  function neededFetches(backendUrl) {
    const NIL = Promise.resolve(null);
    const prefs = fetchPreferences(backendUrl);
    if (metric === "burn") return [prefs, NIL, fetchHourlyLastHour(backendUrl), NIL];
    if (metric === "5h" || metric === "weekly") return [prefs, NIL, NIL, fetchLimits(backendUrl)];
    // tokens, cost — both need today's overview totals.
    return [prefs, fetchOverviewToday(backendUrl), NIL, NIL];
  }

  async function applyDisplay({ overview, hourly, limits }) {
    const display = buildDisplay(metric, windowMode, { overview, hourly, limits });
    if (lastShort === display.short) return;
    lastShort = display.short;

    tray.setToolTip(`Token Dashboard\n${display.tooltip}`);

    if (isMac) {
      tray.setTitle(menubarEnabled ? display.short : "");
      if (app.dock && typeof app.dock.setBadge === "function") {
        app.dock.setBadge(dockEnabled && display.hasValue ? display.short : "");
      }
    }

    const win = getMainWindow();
    if (isWin && win && !win.isDestroyed()) {
      if (!dockEnabled) {
        try { win.setOverlayIcon(null, ""); } catch (_) {}
        return;
      }
      const dataURL = await renderBadgePNG(win, display.short);
      if (!dataURL || win.isDestroyed()) return;
      try {
        const img = nativeImage.createFromDataURL(dataURL);
        win.setOverlayIcon(display.hasValue ? img : null, display.tooltip);
      } catch (e) {
        console.warn("[overlay] setOverlayIcon failed:", e.message);
      }
    }
  }

  function applyToggleFromPrefs(prefs) {
    if (!prefs) return;
    if (typeof prefs.badge_dock_enabled === "boolean" && prefs.badge_dock_enabled !== dockEnabled) {
      dockEnabled = prefs.badge_dock_enabled;
      lastShort = null;
    }
    if (typeof prefs.badge_menubar_enabled === "boolean" && prefs.badge_menubar_enabled !== menubarEnabled) {
      menubarEnabled = prefs.badge_menubar_enabled;
      lastShort = null;
    }
    if (typeof prefs.badge_window_mode === "string" && VALID_WINDOW_MODES.includes(prefs.badge_window_mode) && prefs.badge_window_mode !== windowMode) {
      windowMode = prefs.badge_window_mode;
      lastShort = null;
    }
  }

  async function fetchAndApply() {
    const backendUrl = getBackendUrl();
    const [prefs, overview, hourly, limits] = await Promise.all(neededFetches(backendUrl));
    applyToggleFromPrefs(prefs);
    if (prefs && typeof prefs.badge_metric === "string" && VALID_METRICS.includes(prefs.badge_metric)) {
      if (prefs.badge_metric !== metric) {
        metric = prefs.badge_metric;
        lastShort = null;
        // Re-fetch with the right endpoints for the newly-active metric.
        const [, ov2, hr2, lim2] = await Promise.all(neededFetches(backendUrl));
        return applyDisplay({ overview: ov2, hourly: hr2, limits: lim2 });
      }
    }
    await applyDisplay({ overview, hourly, limits });
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

  return { fetchAndApply, requestUpdate, destroy, setMetric, setDockEnabled, setMenubarEnabled, setWindowMode };
}

module.exports = { createTray };
