import React, { useEffect, useState } from "react";

const TABS = ["overview", "prompts", "sessions", "token sink", "tips", "settings"];
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

export const Topbar = ({ tab, setTab, range, setRange }) => {
  const version = useVersion();
  return (
  <header className="a-topbar">
    <div className="a-brand a-prompt">
      <span className="a-brand-dot" />
      <span className="a-prompt-path">~/code/dashboard</span>
      <span className="a-prompt-ps1">$</span>
      <span className="a-prompt-cmd">td</span>
      <span className="a-prompt-flag">--range=</span><span className="a-prompt-val">{range}</span>
      <span className="a-prompt-flag">--tab=</span><span className="a-prompt-val">{(tab || "").replace(/\s+/g, "-")}</span>
      <span className="a-prompt-cursor" aria-hidden="true" />
      {version && <span className="a-brand-sub">v{version}</span>}
    </div>
    <nav className="a-nav">
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
    <div className="a-topbar-actions">
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
    </div>
  </header>
  );
};
