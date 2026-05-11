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
  { id: "active_session",  label: "Active session",   note: "current session cost + duration (live)" },
  { id: "last_prompt_cost", label: "Last prompt",     note: "most recent prompt's USD + tokens" },
  { id: "prompts_today",   label: "Prompts today",    note: "count + average cost per prompt" },
  { id: "idle_since",      label: "Idle since",       note: "minutes since last message" },
  { id: "skill_of_day",    label: "Skill of the day", note: "most-used skill today" },
  { id: "wow_delta",       label: "WoW delta",        note: "this week vs last week %" },
  { id: "mom_delta",       label: "MoM delta",        note: "this month vs last month %" },
  { id: "peak_hour",       label: "Peak hour",        note: "busiest hour today + cost" },
];


export const WidgetCard = () => {
  const [selected, setSelected] = useState(["today_live", "burn_rate", "five_h_limit"]);
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [widgetOpen, setWidgetOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const fetchPrefs = async () => {
    try {
      const r = await fetch("/api/preferences");
      const d = await r.json();
      if (!d) return null;
      return d;
    } catch (_) {
      return null;
    }
  };

  useEffect(() => {
    let cancelled = false;
    fetchPrefs()
      .then((d) => {
        if (cancelled || !d) return;
        if (Array.isArray(d.widget_metrics) && d.widget_metrics.length > 0) {
          setSelected(d.widget_metrics);
        }
        if (typeof d.widget_open === "boolean") {
          setWidgetOpen(d.widget_open);
        }
      })
      .finally(() => { if (!cancelled) setLoaded(true); });
    // Poll the widget_open flag — the widget's in-window close button
    // writes through the same flag (via the tauri-side Destroyed event),
    // so this keeps the toggle label honest without an extra channel.
    const t = setInterval(async () => {
      const d = await fetchPrefs();
      if (cancelled || !d) return;
      if (typeof d.widget_open === "boolean") setWidgetOpen(d.widget_open);
    }, 1500);
    return () => { cancelled = true; clearInterval(t); };
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
    } else {
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
    : `${selected.length} selected`;

  const toggleWidget = async () => {
    if (busy) return;
    const next = !widgetOpen;
    setBusy(true);
    setWidgetOpen(next); // optimistic — reconciler picks up within 1s
    try {
      await fetch("/api/preferences", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ widget_open: next }),
      });
    } catch (err) {
      console.error("widget_open write failed", err);
      setWidgetOpen(!next); // roll back
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="a-card">
      <div className="a-card-head">
        <h2>Widget tiles</h2>
        <span className="a-card-meta">{meta}</span>
      </div>
      <div className="a-widget-card-sub">
        <span>
          Pick which metrics to show in the floating widget window.
        </span>
        <button
          className={`a-pill-btn ${widgetOpen ? "" : "is-active"}`}
          onClick={toggleWidget}
          disabled={busy}
        >
          {widgetOpen ? "Close widget" : "Open widget"}
        </button>
      </div>
      <div className="a-widget-picker">
        {WIDGET_METRICS.map((m) => {
          const isOn = selected.includes(m.id);
          return (
            <label
              key={m.id}
              className={`a-widget-pick ${isOn ? "is-active" : ""}`}
            >
              <input
                type="checkbox"
                checked={isOn}
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
