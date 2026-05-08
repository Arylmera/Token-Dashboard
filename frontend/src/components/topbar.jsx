import React from "react";

const TABS = ["overview", "prompts", "sessions", "token sink", "tips", "settings"];
const RANGES = ["1d", "7d", "30d", "90d", "all"];

export const Topbar = ({ tab, setTab, range, setRange }) => (
  <header className="a-topbar">
    <div className="a-brand">
      <span className="a-brand-dot" />
      <span className="a-brand-text">token-dashboard</span>
      <span className="a-brand-sub">v0.4.2</span>
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
