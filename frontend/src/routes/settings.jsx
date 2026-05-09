import React, { useEffect, useState } from "react";
import { D } from "../data-store.js";
import { THEMES } from "../theme.js";

const PLANS = [
  { id: "api",   label: "API (pay-as-you-go)", note: "exact cost as the Anthropic API would bill" },
  { id: "pro",   label: "Pro · $20/mo",        note: "5x usage cap, Sonnet only" },
  { id: "max",   label: "Max · $100/mo",       note: "20x usage cap, Sonnet + Opus" },
  { id: "max-20x", label: "Max-20x · $200/mo", note: "100x usage cap, all models" },
];

const BADGE_METRICS = [
  { id: "tokens",  label: "Tokens today",  note: "billable tokens used today (default)" },
  { id: "cost",    label: "Cost today",    note: "USD spent today" },
  { id: "burn",    label: "Burn rate",     note: "USD per hour, last hour" },
  { id: "5h",      label: "5h window",     note: "% of the rolling 5h limit (toggle remaining/used below)" },
  { id: "weekly",  label: "Weekly window", note: "% of the rolling 7d limit (toggle remaining/used below)" },
];

// ---------- shared atoms ----------

const Toggle = ({ checked, onChange, ariaLabel }) => (
  <button
    type="button"
    role="switch"
    aria-checked={!!checked}
    aria-label={ariaLabel}
    className={`a-toggle ${checked ? "is-on" : ""}`}
    onClick={(e) => { e.preventDefault(); e.stopPropagation(); onChange(!checked); }}
  >
    <span className="a-toggle-thumb" />
  </button>
);

const SettingRow = ({ title, description, checked, onChange }) => (
  <div
    className={`a-setting-row ${checked ? "is-on" : ""}`}
    role="button"
    tabIndex={0}
    onClick={() => onChange(!checked)}
    onKeyDown={(e) => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); onChange(!checked); } }}
  >
    <div className="a-setting-row-text">
      <div className="a-setting-row-title">{title}</div>
      {description && <div className="a-setting-row-desc">{description}</div>}
    </div>
    <Toggle checked={checked} onChange={onChange} ariaLabel={title} />
  </div>
);

const SettingsGroup = ({ title, description, children }) => (
  <div className="a-settings-group">
    <div className="a-settings-group-head">
      <span className="a-settings-group-title">{title}</span>
      {description && <span className="a-settings-group-desc">{description}</span>}
    </div>
    <div className="a-settings-group-body">{children}</div>
  </div>
);

// ---------- theme ----------

const ThemeSwatch = ({ theme, active, onPick }) => {
  const sw = theme.swatch || {};
  return (
    <button
      type="button"
      className={`a-theme-swatch ${active ? "is-active" : ""}`}
      onClick={onPick}
      title={theme.label}
      aria-pressed={active}
    >
      <span
        className="a-theme-swatch-preview"
        style={{ background: sw.bg, borderColor: active ? sw.accent : undefined }}
      >
        <span className="a-tspw-bar" style={{ background: sw.panel }} />
        <span className="a-tspw-bar2" style={{ background: sw.fg, opacity: 0.55 }} />
        <span className="a-tspw-dot" style={{ background: sw.accent }} />
      </span>
      <span className="a-theme-swatch-label">{theme.label}</span>
    </button>
  );
};

const ThemeCard = ({ themeIdx, onPickTheme }) => {
  const dark  = THEMES.map((t, i) => [t, i]).filter(([t]) => t.mode === "dark");
  const light = THEMES.map((t, i) => [t, i]).filter(([t]) => t.mode === "light");
  return (
    <section className="a-card">
      <div className="a-card-head"><h2>Theme</h2><span className="a-card-meta">appearance</span></div>
      <div className="a-theme-mode-row">
        <span className="a-label">Dark</span>
        <div className="a-theme-swatch-grid">
          {dark.map(([t, i]) => (
            <ThemeSwatch key={t.id} theme={t} active={themeIdx === i} onPick={() => onPickTheme(i)} />
          ))}
        </div>
      </div>
      <div className="a-theme-mode-row">
        <span className="a-label">Light</span>
        <div className="a-theme-swatch-grid">
          {light.map(([t, i]) => (
            <ThemeSwatch key={t.id} theme={t} active={themeIdx === i} onPick={() => onPickTheme(i)} />
          ))}
        </div>
      </div>
    </section>
  );
};

// ---------- plan & pricing ----------

const PlanCard = ({ plan, saving, onPick }) => (
  <section className="a-card">
    <div className="a-card-head">
      <h2>Pricing plan</h2>
      <span className="a-card-meta">{saving ? "saving…" : "drives all cost figures"}</span>
    </div>
    <div className="a-plans">
      {PLANS.map((p) => (
        <label key={p.id} className={`a-plan ${plan === p.id ? "is-active" : ""}`}>
          <input type="radio" name="plan" checked={plan === p.id} onChange={() => onPick(p.id)} />
          <div>
            <div className="a-plan-title">{p.label}</div>
            <div className="a-plan-note">{p.note}</div>
          </div>
        </label>
      ))}
    </div>
  </section>
);

const PricingTable = () => {
  const models = (D.plan && D.plan.pricing && D.plan.pricing.models) || {};
  return (
    <section className="a-card">
      <div className="a-card-head"><h2>Pricing table</h2><span className="a-card-meta">USD per 1M tokens</span></div>
      <div className="a-table-scroll">
        <table className="a-table a-pricing-table">
          <thead>
            <tr>
              <th>Model</th>
              <th className="num">Input</th>
              <th className="num">Output</th>
              <th className="num">Cache read</th>
              <th className="num">Cache 5m</th>
              <th className="num">Cache 1h</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(models).map(([id, r]) => (
              <tr key={id}>
                <td><span className={`a-badge badge-${r.tier}`}>{id}</span></td>
                <td className="num">${r.input.toFixed(2)}</td>
                <td className="num">${r.output.toFixed(2)}</td>
                <td className="num">${r.cache_read.toFixed(2)}</td>
                <td className="num">${r.cache_create_5m.toFixed(2)}</td>
                <td className="num">${r.cache_create_1h.toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
};

// ---------- status indicator (badge) ----------

const BadgeCard = ({ limitsEnabled }) => {
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
  const anyEnabled = dockEnabled || menubarEnabled;
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

// ---------- limits ----------

const LimitsToggleCard = ({ enabled, onChange, loaded, saving }) => (
  <section className="a-card">
    <div className="a-card-head">
      <h2>Plan limit estimates</h2>
      <span className="a-card-meta">{saving ? "saving…" : (loaded ? "rough community estimates" : "loading…")}</span>
    </div>
    <SettingRow
      title="Show 5h and weekly window usage"
      description="Anthropic doesn't publish exact token quotas — these caps are approximate and can be unreliable. Disabling hides the “Plan limits remaining” card on Overview and the 5h / Weekly options for the status indicator."
      checked={enabled}
      onChange={onChange}
    />
  </section>
);

// ---------- budgets ----------

const BUDGET_FIELDS = [
  { id: "daily",   label: "Daily cap",   note: "warns once today's spend trends toward this number" },
  { id: "weekly",  label: "Weekly cap",  note: "rolling Monday-to-Sunday spend" },
  { id: "monthly", label: "Monthly cap", note: "calendar-month spend" },
];

const BudgetCard = () => {
  const [values, setValues] = useState({ daily: "", weekly: "", monthly: "" });
  const [drafts, setDrafts] = useState({ daily: "", weekly: "", monthly: "" });
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/budget")
      .then((r) => r.json())
      .then((d) => {
        if (cancelled || !d) return;
        const next = {
          daily:   d.daily?.cap_usd   != null ? String(d.daily.cap_usd)   : "",
          weekly:  d.weekly?.cap_usd  != null ? String(d.weekly.cap_usd)  : "",
          monthly: d.monthly?.cap_usd != null ? String(d.monthly.cap_usd) : "",
        };
        setValues(next);
        setDrafts(next);
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, []);
  const persist = async (key, raw) => {
    const trimmed = String(raw || "").trim();
    const amount = trimmed === "" ? null : Number(trimmed);
    if (trimmed !== "" && (Number.isNaN(amount) || amount < 0)) return;
    setSaving(true);
    try {
      await fetch("/api/budget", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [key]: amount }),
      });
      setValues((v) => ({ ...v, [key]: trimmed }));
      if (window.RELOAD_STATIC) window.RELOAD_STATIC();
    } catch (_) {}
    setSaving(false);
  };
  return (
    <section className="a-card">
      <div className="a-card-head">
        <h2>Budgets</h2>
        <span className="a-card-meta">{saving ? "saving…" : (loaded ? "leave blank to disable a window" : "loading…")}</span>
      </div>
      <div className="a-budget-grid">
        {BUDGET_FIELDS.map((f) => (
          <label key={f.id} className="a-budget-field">
            <div className="a-plan-title">{f.label}</div>
            <div className="a-plan-note">{f.note}</div>
            <div className="a-budget-input">
              <span className="a-budget-currency">$</span>
              <input
                type="number"
                inputMode="decimal"
                min="0"
                step="0.01"
                value={drafts[f.id]}
                placeholder="—"
                onChange={(e) => setDrafts((d) => ({ ...d, [f.id]: e.target.value }))}
                onBlur={(e) => { if (e.target.value !== values[f.id]) persist(f.id, e.target.value); }}
                onKeyDown={(e) => { if (e.key === "Enter") e.target.blur(); }}
              />
            </div>
          </label>
        ))}
      </div>
    </section>
  );
};

// ---------- backup ----------

const BackupCard = () => {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState(null);
  const onPick = async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";  // allow re-picking the same file
    if (!file) return;
    setBusy(true);
    setStatus({ kind: "info", text: `merging ${file.name}…` });
    try {
      const r = await fetch("/api/import.db", {
        method: "POST",
        headers: { "Content-Type": "application/x-sqlite3" },
        body: file,
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setStatus({ kind: "bad", text: `failed: ${d.error || r.statusText}` });
      } else {
        setStatus({
          kind: "good",
          text: `merged · +${d.messages_added} messages · +${d.tags_added} tags`,
        });
        if (window.RELOAD_DATA) window.RELOAD_DATA();
      }
    } catch (err) {
      setStatus({ kind: "bad", text: `failed: ${err.message || err}` });
    }
    setBusy(false);
  };
  return (
    <section className="a-card">
      <div className="a-card-head">
        <h2>Backup &amp; portability</h2>
        <span className="a-card-meta">SQLite snapshot · safe during scans</span>
      </div>
      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <a className="a-pill-btn" href="/api/export.db" download>
          <span style={{ marginRight: 6 }}>↓</span>export DB
        </a>
        <label className={`a-pill-btn ${busy ? "is-busy" : ""}`} style={{ cursor: busy ? "wait" : "pointer" }}>
          <span style={{ marginRight: 6 }}>↑</span>{busy ? "importing…" : "import DB"}
          <input
            type="file"
            accept=".db,application/x-sqlite3"
            onChange={onPick}
            disabled={busy}
            style={{ display: "none" }}
          />
        </label>
        <span className="a-card-meta" style={{ flex: 1, minWidth: 200 }}>
          Export downloads a consistent copy of <code>~/.claude/token-dashboard.db</code>. Import merges another machine's export by <code>(session_id, message_id)</code> — same project on two machines may show under two slugs until project mapping lands.
        </span>
      </div>
      {status && (
        <div
          className={`a-card-meta ${status.kind === "bad" ? "tone-bad" : status.kind === "good" ? "tone-good" : ""}`}
          style={{ marginTop: 8 }}
        >
          {status.text}
        </div>
      )}
    </section>
  );
};

// ---------- attached sources ----------

const formatBytes = (n) => {
  if (n == null) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
};

const SourcesCard = () => {
  const [sources, setSources] = useState([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const reload = async () => {
    try {
      const r = await fetch("/api/sources", { cache: "no-store" });
      if (!r.ok) {
        setSources([]);
        setLoaded(true);
        return;
      }
      const d = await r.json();
      setSources(Array.isArray(d) ? d : []);
    } catch (e) {
      setSources([]);
    } finally {
      setLoaded(true);
    }
  };
  useEffect(() => {
    reload();
    const onFocus = () => reload();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);
  const onPick = async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    setBusy(true);
    setStatus({ kind: "info", text: `attaching ${file.name}…` });
    try {
      const r = await fetch("/api/sources/add", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-sqlite3",
          "X-Source-Filename": file.name,
        },
        body: file,
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setStatus({ kind: "bad", text: `failed: ${d.error || r.statusText}` });
      } else {
        setStatus({ kind: "good", text: `attached as ${d.name}` });
        await reload();
        if (window.RELOAD_DATA) window.RELOAD_DATA();
      }
    } catch (err) {
      setStatus({ kind: "bad", text: `failed: ${err.message || err}` });
    }
    setBusy(false);
  };
  const onToggle = async (name, enabled) => {
    setSources((rows) => rows.map((r) => (r.name === name ? { ...r, enabled } : r)));
    try {
      await fetch(`/api/sources/${encodeURIComponent(name)}/toggle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      if (window.RELOAD_DATA) window.RELOAD_DATA();
    } catch (_) {
      reload();
    }
  };
  const onDelete = async (name) => {
    if (!window.confirm(`Remove source "${name}"? The .db file will be deleted from disk.`)) return;
    try {
      await fetch(`/api/sources/${encodeURIComponent(name)}/delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      await reload();
      if (window.RELOAD_DATA) window.RELOAD_DATA();
    } catch (_) {}
  };
  return (
    <section className="a-card">
      <div className="a-card-head">
        <h2>Attached sources</h2>
        <span className="a-card-meta">
          {loaded ? `${sources.length} attached · unioned into reads when enabled` : "loading…"}
        </span>
      </div>
      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <label className={`a-pill-btn ${busy ? "is-busy" : ""}`} style={{ cursor: busy ? "wait" : "pointer" }}>
          <span style={{ marginRight: 6 }}>+</span>{busy ? "attaching…" : "attach DB file"}
          <input
            type="file"
            accept=".db,application/x-sqlite3"
            onChange={onPick}
            disabled={busy}
            style={{ display: "none" }}
          />
        </label>
        <span className="a-card-meta" style={{ flex: 1, minWidth: 200 }}>
          Unlike "import DB" (which merges into the local DB), attached sources stay as separate files. Toggle each one to include or exclude its data from every dashboard query. Best for unioning DBs from <em>different</em> machines — re-attaching your own export will double totals.
        </span>
      </div>
      {status && (
        <div
          className={`a-card-meta ${status.kind === "bad" ? "tone-bad" : status.kind === "good" ? "tone-good" : ""}`}
          style={{ marginTop: 8 }}
        >
          {status.text}
        </div>
      )}
      {sources.length > 0 && (
        <div className="a-table-scroll" style={{ marginTop: 12 }}>
          <table className="a-table">
            <thead>
              <tr>
                <th>Source</th>
                <th className="num">Size</th>
                <th>Added</th>
                <th>Enabled</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {sources.map((s) => (
                <tr key={s.name}>
                  <td>
                    <span className="mono">{s.name}</span>
                    {!s.exists && <span className="a-card-meta tone-bad" style={{ marginLeft: 8 }}>file missing</span>}
                  </td>
                  <td className="num">{formatBytes(s.size_bytes)}</td>
                  <td className="a-card-meta">
                    {s.added_at ? new Date(s.added_at * 1000).toLocaleString() : "—"}
                  </td>
                  <td>
                    <Toggle
                      checked={s.enabled}
                      onChange={(v) => onToggle(s.name, v)}
                      ariaLabel={`enable ${s.name}`}
                    />
                  </td>
                  <td>
                    <button className="a-pill-btn" onClick={() => onDelete(s.name)}>remove</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
};

// ---------- glass ----------

const isElectronApp = () => typeof window !== "undefined" && !!window.td;

const applyGlassClass = (on) => {
  const root = document.querySelector(".dir-a-root");
  if (!root) return;
  // Glass requires a transparent OS-level window (vibrancy/acrylic). In a
  // plain browser, stripping the body background would just reveal white,
  // so never apply the class outside the Electron app.
  root.classList.toggle("is-glass", !!on && isElectronApp());
};

const applyGlassOpacity = (pct) => {
  const root = document.querySelector(".dir-a-root");
  if (!root) return;
  root.style.setProperty("--glass-opacity", `${Math.max(0, Math.min(100, pct))}%`);
};

const GlassCard = () => {
  const [enabled, setEnabled] = useState(false);
  const [opacity, setOpacity] = useState(25);
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/preferences")
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        const on = !!(d && d.glass_enabled);
        const op = (d && typeof d.glass_opacity === "number") ? d.glass_opacity : 25;
        setEnabled(on);
        setOpacity(op);
        applyGlassClass(on);
        applyGlassOpacity(op);
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, []);
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
  const onToggle = (next) => {
    setEnabled(next);
    applyGlassClass(next);
    try { if (window.td && window.td.setGlass) window.td.setGlass(next); } catch (_) {}
    persist({ glass_enabled: next });
  };
  const onSlide = (e) => {
    const v = parseInt(e.target.value, 10);
    setOpacity(v);
    applyGlassOpacity(v);
  };
  const onSlideCommit = (e) => {
    const v = parseInt(e.target.value, 10);
    persist({ glass_opacity: v });
  };
  const isElectron = isElectronApp();
  const note = isElectron
    ? "translucent window with native blur (macOS / Windows 11)"
    : "only available in the desktop app";
  return (
    <section className="a-card">
      <div className="a-card-head">
        <h2>Glass effect</h2>
        <span className="a-card-meta">{saving ? "saving…" : (loaded ? note : "loading…")}</span>
      </div>
      <SettingRow
        title="Translucent window"
        description="Show desktop wallpaper through the dashboard with a frosted-glass blur."
        checked={enabled}
        onChange={onToggle}
      />
      {enabled && (
        <div className="a-glass-slider">
          <div className="a-glass-slider-head">
            <span className="a-label">Panel opacity</span>
            <span className="a-card-meta mono">{opacity}%</span>
          </div>
          <input
            type="range"
            min="0"
            max="100"
            step="1"
            value={opacity}
            onChange={onSlide}
            onMouseUp={onSlideCommit}
            onTouchEnd={onSlideCommit}
            onKeyUp={onSlideCommit}
          />
          <div className="a-glass-slider-legend">
            <span>more transparent</span>
            <span>more solid</span>
          </div>
        </div>
      )}
    </section>
  );
};

// ---------- developer ----------

const DeveloperCard = () => {
  if (!window.td || typeof window.td.toggleDevTools !== "function") return null;
  return (
    <section className="a-card">
      <div className="a-card-head"><h2>Developer</h2><span className="a-card-meta">renderer debugging</span></div>
      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <button
          className="a-pill-btn"
          onClick={() => { try { window.td.toggleDevTools(); } catch (_) {} }}
        >
          <span style={{ marginRight: 6 }}>{`{}`}</span>open devtools
        </button>
        <span className="a-card-meta">opens a detached Chromium DevTools window</span>
      </div>
    </section>
  );
};

// ---------- about ----------

const AboutCard = () => {
  const [version, setVersion] = useState("");
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/health")
      .then((r) => r.json())
      .then((d) => { if (!cancelled && d && d.version) setVersion(String(d.version)); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, []);
  return (
    <section className="a-card">
      <div className="a-card-head">
        <h2>About</h2>
        <span className="a-card-meta">{loaded ? "build info" : "loading…"}</span>
      </div>
      <dl className="a-glossary">
        <dt>App</dt>
        <dd>token-dashboard</dd>
        <dt>Version</dt>
        <dd className="mono">{version ? `v${version}` : "—"}</dd>
      </dl>
    </section>
  );
};

// ---------- glossary ----------

const Glossary = () => (
  <section className="a-card">
    <div className="a-card-head"><h2>Glossary</h2></div>
    <dl className="a-glossary">
      <dt>input tokens</dt>
      <dd>What you sent to the model — your prompt plus the conversation history. Billed at the lowest rate.</dd>
      <dt>output tokens</dt>
      <dd>What the model generated. Billed at roughly 5x the input rate.</dd>
      <dt>cache read</dt>
      <dd>Repeated input the API already has cached. Billed at 1/10th the input rate. Big <code>CLAUDE.md</code> files become almost free on repeat.</dd>
      <dt>cache write</dt>
      <dd>The first time a chunk of context is sent, it's cached for 5 minutes. Billed at 1.25x input.</dd>
    </dl>
  </section>
);

// ---------- root ----------

export const Settings = ({ themeIdx, onPickTheme }) => {
  const [plan, setPlan] = useState((D.plan && D.plan.plan) || "api");
  const [saving, setSaving] = useState(false);
  const [limitsEnabled, setLimitsEnabled] = useState(false);
  const [limitsSaving, setLimitsSaving] = useState(false);
  const [limitsLoaded, setLimitsLoaded] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/preferences")
      .then((r) => r.json())
      .then((d) => {
        if (cancelled || !d) return;
        if (typeof d.limits_enabled === "boolean") setLimitsEnabled(d.limits_enabled);
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLimitsLoaded(true); });
    return () => { cancelled = true; };
  }, []);
  const onToggleLimits = async (next) => {
    setLimitsEnabled(next);
    setLimitsSaving(true);
    try {
      await fetch("/api/preferences", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ limits_enabled: next }),
      });
      if (window.RELOAD_STATIC) window.RELOAD_STATIC();
    } catch (_) {}
    setLimitsSaving(false);
  };
  const onPick = async (id) => {
    setPlan(id);
    setSaving(true);
    try {
      await fetch("/api/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan: id }),
      });
    } catch (_) {}
    setSaving(false);
  };
  const showDev = typeof window !== "undefined" && window.td && typeof window.td.toggleDevTools === "function";
  return (
    <div className="a-route a-settings">
      <SettingsGroup title="Appearance" description="theme and window styling">
        <ThemeCard themeIdx={themeIdx} onPickTheme={onPickTheme} />
        <GlassCard />
      </SettingsGroup>

      <SettingsGroup title="Pricing &amp; budgets" description="how cost and quotas are calculated">
        <PlanCard plan={plan} saving={saving} onPick={onPick} />
        <BudgetCard />
        <PricingTable />
      </SettingsGroup>

      <SettingsGroup title="Limits &amp; alerts" description="rolling-window estimates and the dock/menubar indicator">
        <LimitsToggleCard enabled={limitsEnabled} onChange={onToggleLimits} loaded={limitsLoaded} saving={limitsSaving} />
        <BadgeCard limitsEnabled={limitsEnabled} />
      </SettingsGroup>

      <SettingsGroup title="Data" description="export, portability, and external sources">
        <BackupCard />
        <SourcesCard />
      </SettingsGroup>

      {showDev && (
        <SettingsGroup title="Advanced">
          <DeveloperCard />
        </SettingsGroup>
      )}

      <SettingsGroup title="Reference">
        <Glossary />
        <AboutCard />
      </SettingsGroup>
    </div>
  );
};
