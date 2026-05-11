import React, { useEffect, useRef, useState } from "react";
import { applyThemeClass, themeIndexFromId, themeIndexFromStorage } from "./theme.js";

// Compact always-on-top widget. Tile contents are driven by the
// `widget_metrics` preference (see Settings → Widget tiles). The widget
// keeps its own light fetch loop for the 90d snapshot — everything else
// comes from MOCK_DATA, which api-client.js keeps fresh via SSE.

const getTauriWindow = () => {
  const t = typeof window !== "undefined" ? window.__TAURI__ : null;
  if (!t || !t.window) return null;
  try { return t.window.getCurrentWindow ? t.window.getCurrentWindow() : null; }
  catch { return null; }
};

const fmtUsd = (v) => {
  if (v == null || Number.isNaN(v)) return "$0";
  if (Math.abs(v) >= 100) return `$${v.toFixed(0)}`;
  return `$${v.toFixed(2)}`;
};

const fmtTokens = (n) => {
  if (!n) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
};

const fmtPct = (frac) => `${((frac || 0) * 100).toFixed(1)}%`;

const fmtResetIn = (iso) => {
  if (!iso) return "—";
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return "now";
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return mm ? `${h}h${mm}m` : `${h}h`;
};

const useTick = (ms = 1000) => {
  const [, set] = useState(0);
  useEffect(() => {
    const id = setInterval(() => set((n) => n + 1), ms);
    return () => clearInterval(id);
  }, [ms]);
};

const useMockData = () => {
  const [snap, setSnap] = useState(() => window.MOCK_DATA || null);
  useEffect(() => {
    let cancelled = false;
    const refresh = () => { if (!cancelled) setSnap(window.MOCK_DATA || null); };
    const id = setInterval(refresh, 2000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);
  return snap;
};

const usePrefs = () => {
  const [prefs, setPrefs] = useState(null);
  useEffect(() => {
    let cancelled = false;
    const load = () => fetch("/api/preferences")
      .then((r) => r.json())
      .then((d) => { if (!cancelled) setPrefs(d); })
      .catch(() => {});
    load();
    // Re-read on preference SSE events (cheap, single endpoint).
    let es = null;
    try {
      es = new EventSource("/api/stream");
      es.addEventListener("preferences", load);
    } catch (_) {}
    return () => {
      cancelled = true;
      if (es) { try { es.close(); } catch (_) {} }
    };
  }, []);
  return prefs;
};

// Dedicated fetcher for the 90d snapshot — MOCK_DATA doesn't carry it.
const use90dCost = (enabled) => {
  const [cost, setCost] = useState(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const load = () => {
      const since = new Date();
      since.setDate(since.getDate() - 90);
      since.setHours(0, 0, 0, 0);
      const url = `/api/overview?since=${encodeURIComponent(since.toISOString())}`;
      fetch(url).then((r) => r.json())
        .then((d) => { if (!cancelled && d) setCost(d.cost_usd || 0); })
        .catch(() => {});
    };
    load();
    const id = setInterval(load, 30_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [enabled]);
  return cost;
};

// Resize the widget window to fit its content. Tauri's LogicalSize takes
// CSS pixels, so no scale-factor math is needed. Width is held at
// whatever the user set last; we only ever adjust height.
const useAutoResize = (rootRef, win, depKey) => {
  useEffect(() => {
    if (!rootRef.current || !win) return;
    const tauri = window.__TAURI__;
    const LogicalSize = tauri && tauri.window && tauri.window.LogicalSize;
    if (!LogicalSize) return;
    let lastH = 0;
    let raf = 0;
    const apply = () => {
      if (!rootRef.current) return;
      const desired = Math.ceil(rootRef.current.scrollHeight);
      if (desired <= 0 || Math.abs(desired - lastH) < 2) return;
      lastH = desired;
      // `window.innerWidth` is already CSS pixels (matches LogicalSize),
      // so no scale-factor conversion is needed.
      const width = Math.max(220, Math.round(window.innerWidth || 280));
      win.setSize(new LogicalSize(width, desired)).catch(() => {});
    };
    const schedule = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(apply);
    };
    const ro = new ResizeObserver(schedule);
    ro.observe(rootRef.current);
    schedule();
    return () => {
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [rootRef, win, depKey]);
};

// Mirror the main window's theme. The backend preferences DB is the
// source of truth (Tauri's webview origin changes per launch, so
// localStorage isn't reliable across runs). usePrefs already fetches and
// SSE-refreshes /api/preferences; we just re-apply whenever prefs.theme
// changes. localStorage is a fallback for the first paint before prefs
// arrive.
// Mirror the main window's translucency. Toggles `.is-glass` on the
// widget root and pushes `--glass-opacity` so the same CSS rules that
// style the main shell apply here. The native acrylic / vibrancy is
// driven from Rust (`set_glass`); this only handles the panel CSS.
const useGlassSync = (prefs, rootRef) => {
  useEffect(() => {
    if (!prefs || !rootRef.current) return;
    const on = !!prefs.glass_enabled && !!(window.td);
    rootRef.current.classList.toggle("is-glass", on);
    const op = typeof prefs.glass_opacity === "number" ? prefs.glass_opacity : 25;
    rootRef.current.style.setProperty(
      "--glass-opacity",
      `${Math.max(0, Math.min(100, op))}%`,
    );
  }, [rootRef, prefs && prefs.glass_enabled, prefs && prefs.glass_opacity]);
};

const useThemeSync = (prefs) => {
  useEffect(() => {
    try { applyThemeClass(themeIndexFromStorage()); } catch (_) {}
  }, []);
  useEffect(() => {
    if (!prefs) return;
    const idx = themeIndexFromId(prefs.theme);
    if (idx >= 0) {
      try { applyThemeClass(idx); } catch (_) {}
    }
  }, [prefs && prefs.theme]);
};

const useTopMostToggle = (win) => {
  const [pinned, setPinned] = useState(true);
  const toggle = () => {
    const next = !pinned;
    setPinned(next);
    if (win && win.setAlwaysOnTop) win.setAlwaysOnTop(next).catch(() => {});
  };
  return [pinned, toggle];
};

const COMPACT_KEY = "td-widget-compact";
const useCompactToggle = () => {
  const [compact, setCompact] = useState(() => {
    try { return localStorage.getItem(COMPACT_KEY) === "1"; } catch (_) { return false; }
  });
  const toggle = () => {
    setCompact((c) => {
      const next = !c;
      try { localStorage.setItem(COMPACT_KEY, next ? "1" : "0"); } catch (_) {}
      return next;
    });
  };
  return [compact, toggle];
};

// Deep-link from widget into the main window. Routes are sanitized
// server-side too; passing an unknown one is a no-op there.
const openMainRoute = (route) => {
  const t = window.__TAURI__;
  if (!t || !t.core || !t.core.invoke) return;
  t.core.invoke("show_main_route", { route }).catch(() => {});
};

// Maps each tile id to the dashboard tab it should drill into. Anything
// not listed lands on overview.
const TILE_ROUTES = {
  today_live:    "prompts",
  today_graph:   "prompts",
  burn_rate:     "sessions",
  range_1d:      "overview",
  range_7d:      "overview",
  range_30d:     "overview",
  range_90d:     "overview",
  range_all:     "overview",
  input_tokens:  "overview",
  output_tokens: "overview",
  cache_hit:     "tips",
  cache_x_cost:  "tips",
  five_h_limit:  "overview",
  active_session:   "sessions",
  last_prompt_cost: "prompts",
  prompts_today:    "prompts",
  idle_since:       "sessions",
  skill_of_day:     "token-sink",
  wow_delta:        "overview",
  mom_delta:        "overview",
  peak_hour:        "overview",
};

// ────────────────────────────── tiles ──────────────────────────────

const Tile = ({ label, value, sub, tone, children }) => (
  <div className={`td-w-kpi ${tone ? `tone-${tone}` : ""}`}>
    <span className="td-w-kpi-label">{label}</span>
    {value != null && <span className="td-w-kpi-value">{value}</span>}
    {sub && <span className="td-w-kpi-sub">{sub}</span>}
    {children}
  </div>
);

const Sparkline = ({ values, height = 26, accentClass = "td-w-spark-accent" }) => {
  const arr = Array.isArray(values) ? values : [];
  if (arr.length === 0) {
    return <svg className="td-w-spark" viewBox="0 0 100 26" preserveAspectRatio="none" />;
  }
  const max = Math.max(0.0001, ...arr);
  const w = 100;
  const h = height;
  const step = arr.length > 1 ? w / (arr.length - 1) : w;
  const pts = arr.map((v, i) => {
    const x = i * step;
    const y = h - (v / max) * (h - 2) - 1;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(" ");
  const area = `0,${h} ${pts} ${w},${h}`;
  return (
    <svg className="td-w-spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      <polygon className="td-w-spark-area" points={area} />
      <polyline className={accentClass} points={pts} />
    </svg>
  );
};

const TodayLiveTile = ({ totals }) => {
  const today = totals.today || 0;
  const yest = totals.yesterday || 0;
  const delta = today - yest;
  const arrow = delta > 0 ? "▲" : delta < 0 ? "▼" : "·";
  const sign = delta >= 0 ? "+" : "−";
  const sub = `${fmtTokens(totals.todayTokens || 0)} tok · ${arrow} ${sign}${fmtUsd(Math.abs(delta))}`;
  return <Tile label="today · live" value={fmtUsd(today)} sub={sub} />;
};

const TodayGraphTile = ({ totals, hourly }) => {
  const today = totals.today || 0;
  const yest = totals.yesterday || 0;
  const delta = today - yest;
  const arrow = delta > 0 ? "▲" : delta < 0 ? "▼" : "·";
  const sign = delta >= 0 ? "+" : "−";
  const sub = `${fmtTokens(totals.todayTokens || 0)} tok · ${arrow} ${sign}${fmtUsd(Math.abs(delta))}`;
  return (
    <Tile label="today · graph" value={fmtUsd(today)} sub={sub}>
      <Sparkline values={hourly || []} />
    </Tile>
  );
};

const BurnRateTile = ({ burn }) => {
  const rate = burn.rate || 0;
  const mul = burn.multiple || 0;
  const sub = mul > 0 ? `${mul.toFixed(1)}× weekly avg` : "—";
  return <Tile label="burn rate" value={`${fmtUsd(rate)}/hr`} sub={sub} />;
};

const RangeTile = ({ label, cost, tokens, compact }) => {
  if (compact) {
    return (
      <div className="td-w-kpi is-compact">
        <span className="td-w-kpi-label">{label}</span>
        <span className="td-w-kpi-value">{fmtUsd(cost || 0)}</span>
        {tokens != null && <span className="td-w-kpi-sub">{fmtTokens(tokens)} tok</span>}
      </div>
    );
  }
  return <Tile label={label} value={fmtUsd(cost || 0)} sub={tokens != null ? `${fmtTokens(tokens)} tok` : null} />;
};

const InputTokensTile = ({ today, compact }) => {
  if (compact) {
    return (
      <div className="td-w-kpi is-compact">
        <span className="td-w-kpi-label">input · today</span>
        <span className="td-w-kpi-value">{fmtTokens(today.inputTokens || 0)}</span>
        <span className="td-w-kpi-sub">input tokens</span>
      </div>
    );
  }
  return <Tile label="input · today" value={fmtTokens(today.inputTokens || 0)} sub="input tokens today" />;
};

const OutputTokensTile = ({ today, compact }) => {
  if (compact) {
    return (
      <div className="td-w-kpi is-compact">
        <span className="td-w-kpi-label">output · today</span>
        <span className="td-w-kpi-value">{fmtTokens(today.outputTokens || 0)}</span>
        <span className="td-w-kpi-sub">output tokens</span>
      </div>
    );
  }
  return <Tile label="output · today" value={fmtTokens(today.outputTokens || 0)} sub="output tokens today" />;
};

const CacheHitTile = ({ today }) => {
  const rate = today.cacheHitRate || 0;
  const tone = rate >= 0.8 ? "good" : rate >= 0.5 ? "warn" : "bad";
  return <Tile label="cache hit · today" value={fmtPct(rate)}
    sub={`${fmtTokens(today.cacheReadTokens || 0)} cached today`} tone={tone} />;
};

const CacheCostTile = ({ today, hourlyDetail }) => {
  const series = Array.isArray(hourlyDetail) ? hourlyDetail : [];
  const cost = series.map((d) => d.cost || 0);
  const cache = series.map((d) => d.cacheRead || 0);
  return (
    <Tile label="cache × cost · today" value={fmtUsd(today.cost || 0)} sub="last 24h">
      <div className="td-w-spark-stack">
        <Sparkline values={cache} height={22} accentClass="td-w-spark-cache" />
        <Sparkline values={cost} height={22} accentClass="td-w-spark-cost" />
      </div>
    </Tile>
  );
};

const fmtDuration = (ms) => {
  if (!ms || ms < 0) return "0m";
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return mm ? `${h}h${mm}m` : `${h}h`;
};

const fmtSignedPct = (pct) => {
  const v = (pct || 0) * 100;
  const sign = v > 0 ? "+" : v < 0 ? "−" : "";
  return `${sign}${Math.abs(v).toFixed(1)}%`;
};

const ActiveSessionTile = ({ active }) => {
  if (!active) return <Tile label="active session" value="—" sub="no recent session" />;
  const sub = `${active.project} · ${fmtDuration(active.durationMs)} · idle ${fmtDuration(active.idleMs)}`;
  return <Tile label="active session" value={fmtUsd(active.cost)} sub={sub} />;
};

const LastPromptTile = ({ last }) => {
  if (!last) return <Tile label="last prompt" value="—" sub="no prompts yet" />;
  const sub = `${fmtTokens(last.tokens)} tok · ${last.model || "—"}`;
  return <Tile label="last prompt" value={fmtUsd(last.cost)} sub={sub} />;
};

const PromptsTodayTile = ({ pt }) => {
  if (!pt || !pt.count) return <Tile label="prompts · today" value="0" sub="no prompts yet" />;
  return <Tile label="prompts · today" value={String(pt.count)} sub={`avg ${fmtUsd(pt.avgCost)} / prompt`} />;
};

const IdleSinceTile = ({ idleSince }) => {
  if (!idleSince) return <Tile label="idle since" value="—" sub="no activity" />;
  const ms = Date.now() - new Date(idleSince).getTime();
  const tone = ms < 5 * 60_000 ? "good" : ms < 30 * 60_000 ? "warn" : "bad";
  return <Tile label="idle since" value={fmtDuration(ms)} sub="since last message" tone={tone} />;
};

const SkillOfDayTile = ({ skill }) => {
  if (!skill) return <Tile label="skill · today" value="—" sub="no skills used" />;
  return <Tile label="skill · today" value={skill.name} sub={`${skill.invocations} invocations`} />;
};

const DeltaTile = ({ label, pair }) => {
  if (!pair) return <Tile label={label} value="—" sub="no data" />;
  const tone = pair.delta > 0 ? "bad" : pair.delta < 0 ? "good" : null;
  const sub = `${fmtUsd(pair.current)} vs ${fmtUsd(pair.previous)}`;
  return <Tile label={label} value={fmtSignedPct(pair.pct)} sub={sub} tone={tone} />;
};

const PeakHourTile = ({ peak }) => {
  if (!peak) return <Tile label="peak hour · today" value="—" sub="no data" />;
  const hh = String(peak.hour).padStart(2, "0");
  return <Tile label="peak hour · today" value={`${hh}:00`} sub={fmtUsd(peak.cost)} />;
};

const FiveHourLimitTile = ({ limits }) => {
  const five = limits && limits.five_hour;
  if (!five) {
    return <Tile label="5h limit" value="—" sub="not synced" />;
  }
  const pct = Math.max(0, Math.min(100, Number(five.percent_used) || 0));
  const tone = pct >= 90 ? "bad" : pct >= 75 ? "warn" : "good";
  return (
    <div className={`td-w-kpi td-w-kpi-bar tone-${tone}`}>
      <div className="td-w-kpi-row">
        <span className="td-w-kpi-label">5h limit</span>
        <span className="td-w-kpi-value-inline">{pct.toFixed(0)}%</span>
        <span className="td-w-kpi-reset">resets in {fmtResetIn(five.resets_at)}</span>
      </div>
      <div className="td-w-bar"><div className="td-w-bar-fill" style={{ width: `${pct}%` }} /></div>
    </div>
  );
};

const RANGE_IDS = new Set(["range_1d", "range_7d", "range_30d", "range_90d", "range_all"]);
const IO_IDS = new Set(["input_tokens", "output_tokens"]);
const groupOf = (id) => {
  if (RANGE_IDS.has(id) || IO_IDS.has(id)) return "small";
  return null;
};

// Wrap a tile so clicking it opens the main window on the mapped route.
// Uses a div (not button) to preserve the existing layout/styling and to
// keep nested SVGs accessible. Pointer events on the drag-region root are
// already filtered by Tauri.
const ClickableTile = ({ id, children }) => {
  const route = TILE_ROUTES[id] || "overview";
  const onClick = (e) => {
    e.stopPropagation();
    openMainRoute(route);
  };
  const onKey = (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openMainRoute(route);
    }
  };
  return (
    <div
      className="td-w-tile-click"
      role="button"
      tabIndex={0}
      title={`Open ${route}`}
      onClick={onClick}
      onKeyDown={onKey}
      data-tauri-drag-region="false"
    >
      {children}
    </div>
  );
};

const renderTile = (id, ctx, compact = false) => {
  const { totals, today, burn, hourly, hourlyDetail, limits, cost90,
          activeSession, lastPrompt, promptsToday, idleSince, skillOfDay,
          wow, mom, peakHour } = ctx;
  switch (id) {
    case "today_live":    return <TodayLiveTile totals={totals} />;
    case "today_graph":   return <TodayGraphTile totals={totals} hourly={hourly} />;
    case "burn_rate":     return <BurnRateTile burn={burn} />;
    case "range_1d":      return <RangeTile label="1D"  cost={totals.today}     tokens={totals.todayTokens} compact={compact} />;
    case "range_7d":      return <RangeTile label="7D"  cost={totals.week}      tokens={totals.weekTokens} compact={compact} />;
    case "range_30d":     return <RangeTile label="30D" cost={totals.month}     tokens={null} compact={compact} />;
    case "range_90d":     return <RangeTile label="90D" cost={cost90 || 0}      tokens={null} compact={compact} />;
    case "range_all":     return <RangeTile label="ALL" cost={totals.cost}      tokens={totals.allTokens} compact={compact} />;
    case "input_tokens":  return <InputTokensTile today={today} compact={compact} />;
    case "output_tokens": return <OutputTokensTile today={today} compact={compact} />;
    case "cache_hit":     return <CacheHitTile today={today} />;
    case "cache_x_cost":  return <CacheCostTile today={today} hourlyDetail={hourlyDetail} />;
    case "five_h_limit":  return <FiveHourLimitTile limits={limits} />;
    case "active_session":   return <ActiveSessionTile active={activeSession} />;
    case "last_prompt_cost": return <LastPromptTile last={lastPrompt} />;
    case "prompts_today":    return <PromptsTodayTile pt={promptsToday} />;
    case "idle_since":       return <IdleSinceTile idleSince={idleSince} />;
    case "skill_of_day":     return <SkillOfDayTile skill={skillOfDay} />;
    case "wow_delta":        return <DeltaTile label="WoW · cost" pair={wow} />;
    case "mom_delta":        return <DeltaTile label="MoM · cost" pair={mom} />;
    case "peak_hour":        return <PeakHourTile peak={peakHour} />;
    default: return null;
  }
};

export const Widget = () => {
  const win = getTauriWindow();
  useTick(15_000); // refresh durations (active_session, idle_since) + reset labels
  const data = useMockData();
  const prefs = usePrefs();
  useThemeSync(prefs);
  const [pinned, togglePinned] = useTopMostToggle(win);
  const [compact, toggleCompact] = useCompactToggle();

  // Honor an explicit empty selection — only fall back to defaults when
  // the prefs payload doesn't carry the field at all.
  const metrics = (prefs && Array.isArray(prefs.widget_metrics))
    ? prefs.widget_metrics
    : ["today_live", "burn_rate", "five_h_limit"];

  const need90d = metrics.includes("range_90d");
  const cost90 = use90dCost(need90d);

  const totals = (data && data.totals) || {};
  const today = (data && data.today) || {};
  const burn = (data && data.burn) || {};
  const limits = (data && data.limits) || null;
  const hourly = (data && data.hourly) || [];
  const hourlyDetail = (data && data.hourlyDetail) || [];

  const activeSession = (data && data.activeSession) || null;
  const lastPrompt    = (data && data.lastPrompt) || null;
  const promptsToday  = (data && data.promptsToday) || null;
  const idleSince     = (data && data.idleSince) || null;
  const skillOfDay    = (data && data.skillOfDay) || null;
  const wow           = (data && data.wow) || null;
  const mom           = (data && data.mom) || null;
  const peakHour      = (data && data.peakHour) || null;

  const ctx = { totals, today, burn, hourly, hourlyDetail, limits, cost90,
    activeSession, lastPrompt, promptsToday, idleSince, skillOfDay,
    wow, mom, peakHour };
  const rootRef = useRef(null);
  // Re-run auto-resize when compact toggles — the layout height changes.
  useAutoResize(rootRef, win, `${metrics.join(",")}|c=${compact ? 1 : 0}`);
  useGlassSync(prefs, rootRef);

  return (
    <div className={`td-w-root dir-a-root${compact ? " is-compact" : ""}`} ref={rootRef} data-tauri-drag-region>
      <div className="td-w-head" data-tauri-drag-region>
        <span className="td-w-brand">
          <span className="a-brand-dot" />
          <span className="td-w-brand-text">token dashboard</span>
        </span>
        <div className="td-w-head-actions" data-tauri-drag-region="false">
          <button
            className={`td-w-btn ${pinned ? "is-on" : ""}`}
            title={pinned ? "Unpin" : "Pin on top"}
            onClick={togglePinned}
          >
            <svg width="11" height="11" viewBox="0 0 11 11"><path d="M5.5 1.5l1.5 2.5 2 .5-1.5 1.5.5 2.5-2.5-1-2.5 1 .5-2.5L2 4.5l2-.5z" fill={pinned ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1" /></svg>
          </button>
          <button
            className={`td-w-btn ${compact ? "is-on" : ""}`}
            title={compact ? "Expand widget" : "Compact widget"}
            onClick={toggleCompact}
          >
            {compact
              ? <svg width="11" height="11" viewBox="0 0 11 11"><path d="M2 4h7M2 7h7" stroke="currentColor" strokeWidth="1" fill="none" /></svg>
              : <svg width="11" height="11" viewBox="0 0 11 11"><path d="M2 3h7M2 5.5h7M2 8h7" stroke="currentColor" strokeWidth="1" fill="none" /></svg>}
          </button>
          <button
            className="td-w-btn"
            title="Open dashboard"
            onClick={() => {
              const t = window.__TAURI__;
              if (t && t.core && t.core.invoke) t.core.invoke("show_main").catch(() => {});
            }}
          >
            <svg width="11" height="11" viewBox="0 0 11 11"><path d="M2 2h3M2 2v3M2 2l3 3M9 9H6M9 9V6M9 9L6 6" stroke="currentColor" strokeWidth="1" fill="none" /></svg>
          </button>
          <button
            className="td-w-btn td-w-btn-close"
            title="Close widget"
            onClick={() => win && win.close && win.close()}
          >
            <svg width="11" height="11" viewBox="0 0 11 11"><path d="M2 2l7 7M9 2l-7 7" stroke="currentColor" strokeWidth="1" /></svg>
          </button>
        </div>
      </div>
      <div className="td-w-stack">
        {(() => {
          const out = [];
          let i = 0;
          while (i < metrics.length) {
            const id = metrics[i];
            const g = groupOf(id);
            if (g) {
              const group = [];
              while (i < metrics.length && groupOf(metrics[i]) === g) {
                group.push(metrics[i]);
                i++;
              }
              if (group.length >= 2) {
                out.push(
                  <div key={`${g}-row-${group.join("-")}`} className="td-w-range-row">
                    {group.map((m) => (
                      <div key={m} className="td-w-range-cell">
                        <ClickableTile id={m}>{renderTile(m, ctx, true)}</ClickableTile>
                      </div>
                    ))}
                  </div>
                );
              } else {
                out.push(
                  <div key={group[0]} className="td-w-stack-item">
                    <ClickableTile id={group[0]}>{renderTile(group[0], ctx)}</ClickableTile>
                  </div>
                );
              }
            } else {
              out.push(
                <div key={id} className="td-w-stack-item">
                  <ClickableTile id={id}>{renderTile(id, ctx)}</ClickableTile>
                </div>
              );
              i++;
            }
          }
          return out;
        })()}
      </div>
    </div>
  );
};
