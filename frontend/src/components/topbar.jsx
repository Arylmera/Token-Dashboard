import React, { useEffect, useState } from "react";
import { DateInput } from "./date-input.jsx";

const TABS = ["overview", "budget", "cache", "prompts", "sessions", "token sink", "tips", "api", "settings"];
const TAB_LABELS = { "token sink": "sink" };
const ADVANCED_TABS = new Set(["api"]);
const RANGES = ["1d", "7d", "30d", "90d", "all", "custom"];
const PROVIDERS = [
  { id: "all", label: "all" },
  { id: "claude", label: "claude" },
  { id: "codex", label: "codex" },
];

// yyyy-mm-dd → ISO at local midnight. The backend's `range_clause` does a
// string compare on `timestamp`, so we hand it an ISO with seconds.
const dateToIso = (yyyymmdd, endOfDay) => {
  if (!yyyymmdd) return null;
  const d = new Date(yyyymmdd + (endOfDay ? "T23:59:59" : "T00:00:00"));
  return isNaN(d) ? null : d.toISOString();
};

// The backend scans every 10s and the SSE polling fallback runs at 15s, so a
// healthy dashboard sees `td:data` at least every ~15s. Anything older than
// STALE_AFTER_MS means the refresh pipeline is broken (SSE wedged, backend
// dead, OS sleep). Treat that as a liveness warning, not a fine-grained clock.
const STALE_AFTER_MS = 30_000;

const fmtFreshness = (ms) => {
  if (ms == null) return { label: "—", stale: false };
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < STALE_AFTER_MS / 1000) {
    return { label: s < 5 ? "just now" : `${s}s ago`, stale: false };
  }
  const m = Math.floor(s / 60);
  if (m < 1) return { label: "stale", stale: true };
  if (m < 60) return { label: `stale ${m}m`, stale: true };
  return { label: "stale 1h+", stale: true };
};

const useLastRefresh = () => {
  const [stamp, setStamp] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const onData = () => {
      const t = Date.now();
      setStamp(t);
      setNow(t);
    };
    window.addEventListener("td:data", onData);
    const id = setInterval(() => setNow(Date.now()), 5000);
    return () => {
      window.removeEventListener("td:data", onData);
      clearInterval(id);
    };
  }, []);
  return fmtFreshness(now - stamp);
};

const useVersion = () => {
  const [version, setVersion] = useState("");
  useEffect(() => {
    let cancelled = false;
    fetch("/api/health")
      .then((r) => r.json())
      .then((d) => { if (!cancelled && d && d.version) setVersion(String(d.version)); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);
  return version;
};

const getTauriWindow = () => {
  const t = typeof window !== "undefined" ? window.__TAURI__ : null;
  if (!t || !t.window) return null;
  try { return t.window.getCurrentWindow ? t.window.getCurrentWindow() : null; }
  catch { return null; }
};

const WindowControls = () => {
  const win = getTauriWindow();
  const [maxed, setMaxed] = useState(false);
  useEffect(() => {
    if (!win) return;
    let cancelled = false;
    const refresh = () => win.isMaximized().then((m) => { if (!cancelled) setMaxed(m); }).catch(() => {});
    refresh();
    const unlistenP = win.onResized ? win.onResized(refresh) : null;
    return () => { cancelled = true; if (unlistenP) Promise.resolve(unlistenP).then((fn) => fn && fn()); };
  }, [win]);
  if (!win) return null;
  return (
    <div className="a-wincontrols" data-tauri-drag-region="false">
      <button className="a-winbtn" aria-label="Minimize" onClick={() => win.minimize()}>
        <svg width="10" height="10" viewBox="0 0 10 10"><rect x="1" y="4.5" width="8" height="1" fill="currentColor" /></svg>
      </button>
      <button className="a-winbtn" aria-label={maxed ? "Restore" : "Maximize"} onClick={() => win.toggleMaximize()}>
        {maxed ? (
          <svg width="10" height="10" viewBox="0 0 10 10"><rect x="1.5" y="2.5" width="6" height="6" fill="none" stroke="currentColor" /><rect x="2.5" y="1.5" width="6" height="6" fill="none" stroke="currentColor" /></svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 10 10"><rect x="1.5" y="1.5" width="7" height="7" fill="none" stroke="currentColor" /></svg>
        )}
      </button>
      <button className="a-winbtn a-winbtn-close" aria-label="Close" onClick={() => win.close()}>
        <svg width="10" height="10" viewBox="0 0 10 10"><path d="M1.5 1.5l7 7M8.5 1.5l-7 7" stroke="currentColor" strokeWidth="1" /></svg>
      </button>
    </div>
  );
};

export const Topbar = ({ tab, setTab, range, setRange, provider = "all", setProvider, advancedMode = false }) => {
  const version = useVersion();
  const lastRefresh = useLastRefresh();
  const visibleTabs = TABS.filter((t) => advancedMode || !ADVANCED_TABS.has(t));
  const [customSince, setCustomSince] = useState("");
  const [customUntil, setCustomUntil] = useState("");
  // Push the custom dates to the data layer whenever either bound changes
  // *and* we're actually in custom mode. Switching back to a preset clears
  // the override; selecting "custom" with no dates yet is a no-op.
  useEffect(() => {
    if (range !== "custom") return;
    if (!window.SET_CUSTOM_RANGE) return;
    const since = dateToIso(customSince, false);
    const until = dateToIso(customUntil, true);
    if (since || until) window.SET_CUSTOM_RANGE(since, until);
  }, [range, customSince, customUntil]);
  return (
  <header className="a-topbar" data-tauri-drag-region>
    <div className="a-brand a-prompt" data-tauri-drag-region>
      <span className="a-brand-dot" />
      <span className="a-prompt-path">~/code/dashboard</span>
      <span className="a-prompt-ps1">$</span>
      <span className="a-prompt-cmd">td</span>
      <span className="a-prompt-cursor" aria-hidden="true">▍</span>
      <span
        className={`a-prompt-fresh${lastRefresh.stale ? " is-stale" : ""}`}
        title={
          lastRefresh.stale
            ? "Refresh pipeline is stalled (SSE + polling both silent). Try reloading."
            : "Time since the dashboard last received fresh data"
        }
      >
        {lastRefresh.label}
      </span>
    </div>
    <nav className="a-nav" data-tauri-drag-region="false">
      {visibleTabs.map((t) => (
        <button
          key={t}
          data-tab={t}
          className={`a-navlink ${tab === t ? "is-active" : ""}`}
          onClick={() => setTab(t)}
        >
          {TAB_LABELS[t] || t}
        </button>
      ))}
    </nav>
    <div className="a-topbar-actions" data-tauri-drag-region="false">
      {version && <span className="a-brand-sub">v{version}</span>}
      <div className="a-range">
        {RANGES.map((r) => (
          <button
            key={r}
            className={`a-range-tab ${range === r ? "is-active" : ""}`}
            onClick={() => setRange(r)}
          >
            {r}
          </button>
        ))}
      </div>
      {setProvider && (
        <div className="a-range" role="group" aria-label="Provider filter">
          {PROVIDERS.map((p) => (
            <button
              key={p.id}
              className={`a-range-tab ${provider === p.id ? "is-active" : ""}`}
              onClick={() => setProvider(p.id)}
            >
              {p.label}
            </button>
          ))}
        </div>
      )}
      {range === "custom" && (
        <div className="a-range-custom" data-tauri-drag-region="false">
          <DateInput value={customSince} onChange={setCustomSince} ariaLabel="Range start" />
          <span className="a-range-custom-sep">→</span>
          <DateInput value={customUntil} onChange={setCustomUntil} ariaLabel="Range end" />
        </div>
      )}
      <WindowControls />
    </div>
  </header>
  );
};
