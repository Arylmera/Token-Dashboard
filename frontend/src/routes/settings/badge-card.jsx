import React, { useEffect, useState } from "react";
import { SettingRow } from "./atoms.jsx";

const BADGE_METRICS = [
  { id: "tokens",  label: "Tokens today",  note: "billable tokens used today (default)" },
  { id: "cost",    label: "Cost today",    note: "USD spent today" },
  { id: "burn",    label: "Burn rate",     note: "USD per hour, last hour" },
  { id: "5h",      label: "5h window",     note: "% of the rolling 5h limit (toggle remaining/used below)" },
  { id: "weekly",  label: "Weekly window", note: "% of the rolling 7d limit (toggle remaining/used below)" },
];

export const BadgeCard = ({ limitsEnabled }) => {
  const [metric, setMetric] = useState("tokens");
  const [windowMode, setWindowMode] = useState("remaining");
  const [dockEnabled, setDockEnabled] = useState(true);
  const [menubarEnabled, setMenubarEnabled] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/preferences")
      .then((r) => r.json())
      .then((d) => {
        if (cancelled || !d) return;
        if (d.badge_metric) setMetric(d.badge_metric);
        if (d.badge_window_mode) setWindowMode(d.badge_window_mode);
        if (typeof d.badge_dock_enabled === "boolean") setDockEnabled(d.badge_dock_enabled);
        if (typeof d.badge_menubar_enabled === "boolean") setMenubarEnabled(d.badge_menubar_enabled);
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    if (limitsEnabled === false && (metric === "5h" || metric === "weekly")) {
      setMetric("tokens");
      fetch("/api/preferences", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ badge_metric: "tokens" }),
      }).catch(() => {});
    }
  }, [limitsEnabled, metric]);
  const visibleMetrics = limitsEnabled === false
    ? BADGE_METRICS.filter((p) => p.id !== "5h" && p.id !== "weekly")
    : BADGE_METRICS;
  const persist = async (body) => {
    setSaving(true);
    try {
      await fetch("/api/preferences", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (_) {}
    setSaving(false);
  };
  const onPick = (id) => { setMetric(id); persist({ badge_metric: id }); };
  const onToggleDock = (v) => { setDockEnabled(v); persist({ badge_dock_enabled: v }); };
  const onToggleMenubar = (v) => { setMenubarEnabled(v); persist({ badge_menubar_enabled: v }); };
  const onPickWindowMode = (m) => { setWindowMode(m); persist({ badge_window_mode: m }); };
  const isMac = typeof window !== "undefined" && window.td && window.td.platform === "darwin";
  const subtitle = isMac
    ? "shown on the dock badge and macOS menu bar"
    : "shown on the taskbar overlay (Electron app only)";
  const anyEnabled = isMac ? (dockEnabled || menubarEnabled) : dockEnabled;
  return (
    <section className="a-card">
      <div className="a-card-head">
        <h2>Status indicator</h2>
        <span className="a-card-meta">{saving ? "saving…" : (loaded ? subtitle : "loading…")}</span>
      </div>
      <div className="a-setting-rows">
        <SettingRow
          title={isMac ? "Show dock badge" : "Show taskbar overlay"}
          description={isMac ? "red badge on the dock icon" : "small badge on the Windows taskbar icon"}
          checked={dockEnabled}
          onChange={onToggleDock}
        />
        {isMac && (
          <SettingRow
            title="Show in menu bar"
            description="text next to the tray icon at the top of the screen"
            checked={menubarEnabled}
            onChange={onToggleMenubar}
          />
        )}
      </div>
      {anyEnabled && (
        <>
          <div className="a-card-divider" />
          <div className="a-label" style={{ marginBottom: 8 }}>Metric</div>
          <div className="a-plans">
            {visibleMetrics.map((p) => (
              <label key={p.id} className={`a-plan ${metric === p.id ? "is-active" : ""}`}>
                <input type="radio" name="badge_metric" checked={metric === p.id} onChange={() => onPick(p.id)} />
                <div>
                  <div className="a-plan-title">{p.label}</div>
                  <div className="a-plan-note">{p.note}</div>
                </div>
              </label>
            ))}
          </div>
          {(metric === "5h" || metric === "weekly") && (
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 12 }}>
              <span className="a-label">Show as</span>
              <button
                className={`a-pill-btn ${windowMode === "remaining" ? "is-active" : ""}`}
                onClick={() => onPickWindowMode("remaining")}
              >
                % remaining
              </button>
              <button
                className={`a-pill-btn ${windowMode === "used" ? "is-active" : ""}`}
                onClick={() => onPickWindowMode("used")}
              >
                % used
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
};
