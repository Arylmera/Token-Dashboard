import React, { useEffect, useState } from "react";

const ALL_THRESHOLDS = [25, 50, 75, 80, 90, 100];

export function ThresholdPicker() {
  const [cfg, setCfg] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch("/api/budget-alerts/config")
      .then((r) => (r.ok ? r.json() : null))
      .then(setCfg)
      .catch(() => setCfg(null));
  }, []);

  const save = async (next) => {
    setSaving(true);
    try {
      const r = await fetch("/api/budget-alerts/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(next),
      });
      if (r.ok) {
        const updated = await r.json();
        setCfg(updated);
      }
    } finally {
      setSaving(false);
    }
  };

  if (!cfg) {
    return (
      <section className="a-card">
        <div className="a-card-head">
          <h2>Alert thresholds</h2>
        </div>
        <div className="a-hint">Loading…</div>
      </section>
    );
  }

  const enabled = new Set(cfg.thresholds || []);
  const muted = new Set(cfg.muted || []);

  const toggle = (t) => {
    const next = new Set(enabled);
    if (next.has(t)) next.delete(t); else next.add(t);
    save({ thresholds: [...next].sort((a, b) => a - b), muted: cfg.muted });
  };

  const toggleMute = (t) => {
    const next = new Set(muted);
    if (next.has(t)) next.delete(t); else next.add(t);
    save({ thresholds: cfg.thresholds, muted: [...next].sort((a, b) => a - b) });
  };

  return (
    <section className="a-card">
      <div className="a-card-head">
        <h2>Alert thresholds</h2>
        <span className="a-card-meta">
          fire when monthly spend crosses these percentages
        </span>
      </div>
      <div className="a-threshold-row">
        {ALL_THRESHOLDS.map((t) => {
          const on = enabled.has(t);
          const mute = muted.has(t);
          return (
            <label
              key={t}
              className={`a-chip${on ? " is-on" : ""}${mute ? " is-muted" : ""}`}
            >
              <input
                type="checkbox"
                checked={on}
                disabled={saving}
                onChange={() => toggle(t)}
              />
              <span>{t}%</span>
              {on && (
                <button
                  type="button"
                  disabled={saving}
                  onClick={(e) => {
                    e.preventDefault();
                    toggleMute(t);
                  }}
                >
                  {mute ? "muted" : "mute"}
                </button>
              )}
            </label>
          );
        })}
      </div>
      <div className="a-hint">
        Muted thresholds still register but don&apos;t fire notifications.
        Fired state resets at the start of each month.
      </div>
    </section>
  );
}
