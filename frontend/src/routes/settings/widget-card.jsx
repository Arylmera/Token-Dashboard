import React, { useEffect, useState } from "react";

// Catalogue of metric tiles the widget knows how to render. The widget
// itself owns the actual rendering — this list just drives the
// Settings-side picker and provides the canonical order.
const WIDGET_METRICS = [
  { id: "today_live",    label: "Today — live",    note: "today's cost + tokens, with delta vs yesterday" },
  { id: "today_graph",   label: "Today — graph",   note: "hourly sparkline for the last 24h" },
  { id: "burn_rate",     label: "Burn rate",       note: "USD/hour, last hour vs weekly average" },
  { id: "range_1d",      label: "1D",              note: "cost in the last 24h" },
  { id: "range_7d",      label: "7D",              note: "cost in the last 7 days" },
  { id: "range_30d",     label: "30D",             note: "cost in the last 30 days" },
  { id: "range_90d",     label: "90D",             note: "cost in the last 90 days" },
  { id: "range_all",     label: "ALL",             note: "lifetime cost" },
  { id: "input_tokens",  label: "Input tokens",    note: "input tokens used today" },
  { id: "output_tokens", label: "Output tokens",   note: "output tokens used today" },
  { id: "cache_hit",     label: "Cache hit",       note: "today's cache-read share of total tokens" },
  { id: "cache_x_cost",  label: "Cache × cost",    note: "last-24h cache+cost sparkline" },
  { id: "five_h_limit",  label: "5h limit",        note: "rolling 5h-window %, with reset countdown" },
];

const MAX_SELECTED = 6;

export const WidgetCard = () => {
  const [selected, setSelected] = useState(["today_live", "burn_rate", "five_h_limit"]);
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/preferences")
      .then((r) => r.json())
      .then((d) => {
        if (cancelled || !d) return;
        if (Array.isArray(d.widget_metrics) && d.widget_metrics.length > 0) {
          setSelected(d.widget_metrics);
        }
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, []);

  const persist = async (next) => {
    setSaving(true);
    try {
      await fetch("/api/preferences", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ widget_metrics: next }),
      });
    } catch (_) {}
    setSaving(false);
  };

  const toggle = (id) => {
    const has = selected.includes(id);
    let next;
    if (has) {
      next = selected.filter((s) => s !== id);
      if (next.length === 0) return; // never let the widget go fully blank
    } else {
      if (selected.length >= MAX_SELECTED) return;
      // Preserve catalogue order rather than insertion order so the
      // widget layout matches what users see in the picker.
      const order = WIDGET_METRICS.map((m) => m.id);
      next = order.filter((mid) => selected.includes(mid) || mid === id);
    }
    setSelected(next);
    persist(next);
  };

  const meta = saving ? "saving…"
    : !loaded ? "loading…"
    : `${selected.length} / ${MAX_SELECTED} selected`;

  const resolveInvoke = () => {
    const g = (typeof window !== "undefined" && window.__TAURI__) || null;
    if (g && g.core && typeof g.core.invoke === "function") return g.core.invoke.bind(g.core);
    if (g && typeof g.invoke === "function") return g.invoke.bind(g);
    const internals = typeof window !== "undefined" ? window.__TAURI_INTERNALS__ : null;
    if (internals && typeof internals.invoke === "function") return internals.invoke.bind(internals);
    return null;
  };
  const canOpenWidget = !!resolveInvoke();

  const openWidget = () => {
    const invoke = resolveInvoke();
    if (!invoke) {
      console.warn("open_widget: no tauri invoke bridge");
      return;
    }
    invoke("open_widget").catch((err) => {
      console.error("open_widget failed", err);
    });
  };

  return (
    <section className="a-card">
      <div className="a-card-head">
        <h2>Widget tiles</h2>
        <span className="a-card-meta">{meta}</span>
      </div>
      <div className="a-widget-card-sub">
        <span>
          Pick up to {MAX_SELECTED} metrics to show in the floating widget window.
          {!canOpenWidget && <> Open it from the tray menu (<em>Show Widget</em>).</>}
        </span>
        {canOpenWidget && (
          <button className="a-pill-btn is-active" onClick={openWidget}>Open widget</button>
        )}
      </div>
      <div className="a-widget-picker">
        {WIDGET_METRICS.map((m) => {
          const isOn = selected.includes(m.id);
          const disabled = !isOn && selected.length >= MAX_SELECTED;
          return (
            <label
              key={m.id}
              className={`a-widget-pick ${isOn ? "is-active" : ""} ${disabled ? "is-disabled" : ""}`}
            >
              <input
                type="checkbox"
                checked={isOn}
                disabled={disabled}
                onChange={() => toggle(m.id)}
              />
              <div>
                <div className="a-widget-pick-title">{m.label}</div>
                <div className="a-widget-pick-note">{m.note}</div>
              </div>
            </label>
          );
        })}
      </div>
    </section>
  );
};
