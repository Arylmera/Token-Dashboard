import React, { useEffect, useState } from "react";

const TABS = ["overview", "prompts", "sessions", "token sink", "tips", "api", "settings"];
const RANGES = ["1d", "7d", "30d", "90d", "all"];

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

export const Topbar = ({ tab, setTab, range, setRange }) => {
  const version = useVersion();
  return (
  <header className="a-topbar" data-tauri-drag-region>
    <div className="a-brand a-prompt" data-tauri-drag-region>
      <span className="a-brand-dot" />
      <span className="a-prompt-path">~/code/dashboard</span>
      <span className="a-prompt-ps1">$</span>
      <span className="a-prompt-cmd">td</span>
      <span className="a-prompt-flag">--range=</span><span className="a-prompt-val">{range}</span>
      <span className="a-prompt-flag">--tab=</span><span className="a-prompt-val">{(tab || "").replace(/\s+/g, "-")}</span>
      <span className="a-prompt-cursor" aria-hidden="true">▍</span>
    </div>
    <nav className="a-nav" data-tauri-drag-region="false">
      {TABS.map((t) => (
        <button
          key={t}
          data-tab={t}
          className={`a-navlink ${tab === t ? "is-active" : ""}`}
          onClick={() => setTab(t)}
        >
          {t}
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
      <WindowControls />
    </div>
  </header>
  );
};
