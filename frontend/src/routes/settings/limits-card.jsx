import React, { useEffect, useState } from "react";
import { SettingRow } from "./atoms.jsx";

export const LimitsToggleCard = ({ enabled, onChange, loaded, saving }) => (
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

export const LimitsSourceCard = () => {
  const [source, setSource] = useState("jsonl");
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState(null);
  const [lastSyncAt, setLastSyncAt] = useState(null);
  const [lastSyncStatus, setLastSyncStatus] = useState(null);

  const reload = async () => {
    try {
      const r = await fetch("/api/preferences", { cache: "no-store" });
      const d = await r.json();
      if (d.limits_source === "oauth" || d.limits_source === "jsonl") setSource(d.limits_source);
      setLastSyncAt(d.limits_last_sync_at || null);
      setLastSyncStatus(d.limits_last_sync_status || null);
    } catch (_) {}
    setLoaded(true);
  };

  useEffect(() => { reload(); }, []);

  const onPick = async (next) => {
    if (next === source) return;
    setSaving(true);
    setSource(next);
    try {
      await fetch("/api/preferences", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ limits_source: next }),
      });
      if (window.RELOAD_STATIC) window.RELOAD_STATIC();
    } catch (_) {}
    setSaving(false);
  };

  const onSync = async () => {
    setSyncing(true);
    setSyncMsg(null);
    try {
      const r = await fetch("/api/limits/sync_oauth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setSyncMsg({ tone: "bad", text: d.error || `HTTP ${r.status}` });
      } else {
        setLastSyncStatus(d.limits_last_sync_status || d.status || null);
        setLastSyncAt(d.limits_last_sync_at || null);
        if (d.status === "ok") {
          setSyncMsg({ tone: "good", text: "Synced — Overview will show live values." });
        } else if (d.status === "unsupported") {
          setSyncMsg({ tone: "bad", text: "Your account doesn't expose unified-window rate-limit headers." });
        } else {
          setSyncMsg({ tone: "bad", text: `Sync failed: ${(d.status || "").replace(/^error:/, "")}` });
        }
      }
      if (window.RELOAD_STATIC) window.RELOAD_STATIC();
    } catch (e) {
      setSyncMsg({ tone: "bad", text: "Sync request failed." });
    }
    setSyncing(false);
  };

  const options = [
    {
      id: "jsonl",
      title: "Local transcripts",
      desc: "Sum tokens from ~/.claude/projects/ files against a configured cap. Always available; cap is a community estimate unless you calibrate.",
    },
    {
      id: "oauth",
      title: "Claude subscription (live)",
      desc: "Read live 5h / weekly utilization directly from Anthropic's rate-limit headers, using the OAuth token your `claude` login stored. Experimental — undocumented Anthropic flow, may stop working without notice. On macOS the first sync prompts your Keychain for access to the Claude Code credential.",
    },
  ];

  return (
    <section className="a-card">
      <div className="a-card-head">
        <h2>Limits data source</h2>
        <span className="a-card-meta">
          {saving ? "saving…" : (loaded ? "drives the Overview 5h / weekly card" : "loading…")}
        </span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {options.map((o) => (
          <label key={o.id} style={{ display: "flex", gap: 10, alignItems: "flex-start", cursor: "pointer" }}>
            <input
              type="radio"
              name="limits_source"
              checked={source === o.id}
              onChange={() => onPick(o.id)}
              style={{ marginTop: 4 }}
            />
            <div>
              <div className="a-plan-title">{o.title}</div>
              <div className="a-plan-note">{o.desc}</div>
            </div>
          </label>
        ))}
      </div>
      {source === "oauth" && (
        <>
          <div className="a-card-divider" />
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <button type="button" className="a-pill-btn" onClick={onSync} disabled={syncing}>
              {syncing ? "syncing…" : "Sync now"}
            </button>
            <span className="a-card-meta">
              Reads ~/.claude credentials and pings Anthropic for the current rate-limit headers.
            </span>
          </div>
          {(syncMsg || lastSyncStatus) && (
            <div
              className={`a-card-meta ${
                (syncMsg && syncMsg.tone === "good") || lastSyncStatus === "ok"
                  ? "tone-good"
                  : "tone-bad"
              }`}
              style={{ marginTop: 8 }}
            >
              {syncMsg
                ? syncMsg.text
                : lastSyncStatus === "ok"
                  ? `Last sync ${lastSyncAt ? new Date(lastSyncAt).toLocaleString() : ""}`
                  : `Last sync: ${lastSyncStatus}`}
            </div>
          )}
        </>
      )}
    </section>
  );
};

const _isoToParts = (iso) => {
  const empty = { h: "", m: "" };
  if (!iso) return empty;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return empty;
  let secs = Math.max(0, Math.round((t - Date.now()) / 1000));
  const h = Math.floor(secs / 3600); secs -= h * 3600;
  const m = Math.floor(secs / 60);
  return { h: String(h), m: String(m) };
};

const _partsToIso = (parts) => {
  const h = parseInt(parts.h || "0", 10) || 0;
  const m = parseInt(parts.m || "0", 10) || 0;
  if (h === 0 && m === 0) return null;
  const ms = (h * 60 + m) * 60 * 1000;
  return new Date(Date.now() + ms).toISOString().replace(/\.\d{3}Z$/, "Z");
};

const _isoToLocalInput = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const _localInputToIso = (local) => {
  if (!local) return null;
  const d = new Date(local);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
};

const _formatResolved = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
};

export const LimitResetCard = () => {
  const [drafts, setDrafts] = useState({
    limits_five_hour_reset_at: { h: "", m: "" },
    limits_weekly_reset_at:    "",
  });
  const [server, setServer] = useState({ limits_five_hour_reset_at: null, limits_weekly_reset_at: null });
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [keySet, setKeySet] = useState(false);
  const [lastSyncAt, setLastSyncAt] = useState(null);
  const [lastSyncStatus, setLastSyncStatus] = useState(null);
  const [syncing, setSyncing] = useState(false);

  const [capOverrides, setCapOverrides] = useState({ limits_5h_cap_override: null, limits_weekly_cap_override: null });
  const [pctDrafts, setPctDrafts] = useState({ five_hour: "", weekly: "" });
  const [calibrating, setCalibrating] = useState(false);
  const [calibrateMsg, setCalibrateMsg] = useState(null);
  const [liveLimits, setLiveLimits] = useState({ five_hour: null, weekly: null });

  const reloadLive = async () => {
    try {
      const r = await fetch("/api/limits", { cache: "no-store" });
      if (!r.ok) return;
      const d = await r.json();
      setLiveLimits({ five_hour: d.five_hour || null, weekly: d.weekly || null });
    } catch (_) {}
  };

  const reload = async () => {
    try {
      const r = await fetch("/api/preferences", { cache: "no-store" });
      const d = await r.json();
      const next = {
        limits_five_hour_reset_at: d.limits_five_hour_reset_at || null,
        limits_weekly_reset_at:    d.limits_weekly_reset_at    || null,
      };
      setServer(next);
      setDrafts({
        limits_five_hour_reset_at: _isoToParts(next.limits_five_hour_reset_at),
        limits_weekly_reset_at:    _isoToLocalInput(next.limits_weekly_reset_at),
      });
      setCapOverrides({
        limits_5h_cap_override:     d.limits_5h_cap_override     || null,
        limits_weekly_cap_override: d.limits_weekly_cap_override || null,
      });
      setKeySet(!!d.anthropic_api_key_set);
      setLastSyncAt(d.limits_last_sync_at || null);
      setLastSyncStatus(d.limits_last_sync_status || null);
    } catch (_) {}
    setLoaded(true);
  };

  useEffect(() => {
    reload();
    reloadLive();
    const onFocus = () => reloadLive();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  const persist = async (key, value) => {
    setSaving(true);
    try {
      await fetch("/api/preferences", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [key]: value }),
      });
      if (window.RELOAD_STATIC) window.RELOAD_STATIC();
      await reload();
    } catch (_) {}
    setSaving(false);
  };

  const onCommit5h = () => {
    const iso = _partsToIso(drafts.limits_five_hour_reset_at || {});
    if (iso === server.limits_five_hour_reset_at) return;
    persist("limits_five_hour_reset_at", iso);
  };

  const onCommitWeekly = () => {
    const iso = drafts.limits_weekly_reset_at ? _localInputToIso(drafts.limits_weekly_reset_at) : null;
    if (iso === server.limits_weekly_reset_at) return;
    persist("limits_weekly_reset_at", iso);
  };

  const onClear5h = () => {
    setDrafts((d) => ({ ...d, limits_five_hour_reset_at: { h: "", m: "" } }));
    persist("limits_five_hour_reset_at", null);
  };

  const onClearWeekly = () => {
    setDrafts((d) => ({ ...d, limits_weekly_reset_at: "" }));
    persist("limits_weekly_reset_at", null);
  };

  const onPartChange = (part, value) => {
    setDrafts((d) => ({
      ...d,
      limits_five_hour_reset_at: { ...d.limits_five_hour_reset_at, [part]: value.replace(/\D+/g, "") },
    }));
  };

  const onSaveKey = async () => {
    if (!apiKeyDraft.trim()) return;
    await fetch("/api/preferences", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ anthropic_api_key: apiKeyDraft.trim() }),
    });
    setApiKeyDraft("");
    reload();
  };

  const onForgetKey = async () => {
    await fetch("/api/preferences", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ anthropic_api_key: null }),
    });
    reload();
  };

  const onCalibrate = async (windowKey) => {
    const raw = pctDrafts[windowKey];
    const pct = parseFloat(raw);
    if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
      setCalibrateMsg({ tone: "bad", text: "Enter a percentage between 0 and 100." });
      return;
    }
    setCalibrating(true);
    setCalibrateMsg(null);
    try {
      const r = await fetch("/api/limits", { cache: "no-store" });
      const d = await r.json();
      const used = d?.[windowKey]?.used;
      if (!used || used <= 0) {
        setCalibrateMsg({ tone: "bad", text: "No usage recorded yet — let some traffic flow first." });
        setCalibrating(false);
        return;
      }
      const cap = Math.round(used / (pct / 100));
      const prefKey = windowKey === "five_hour" ? "limits_5h_cap_override" : "limits_weekly_cap_override";
      await fetch("/api/preferences", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [prefKey]: cap }),
      });
      setPctDrafts((p) => ({ ...p, [windowKey]: "" }));
      setCalibrateMsg({ tone: "good", text: `Cap set to ${cap.toLocaleString()} sonnet-equiv tokens.` });
      if (window.RELOAD_STATIC) window.RELOAD_STATIC();
      await reload();
      await reloadLive();
    } catch (_) {
      setCalibrateMsg({ tone: "bad", text: "Calibration failed." });
    }
    setCalibrating(false);
  };

  const onClearCap = async (prefKey) => {
    setCalibrating(true);
    try {
      await fetch("/api/preferences", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [prefKey]: null }),
      });
      setCalibrateMsg(null);
      if (window.RELOAD_STATIC) window.RELOAD_STATIC();
      await reload();
      await reloadLive();
    } catch (_) {}
    setCalibrating(false);
  };

  const onSyncNow = async () => {
    setSyncing(true);
    try {
      const r = await fetch("/api/limits/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const d = await r.json();
      setLastSyncStatus(d.limits_last_sync_status || d.status || null);
      setLastSyncAt(d.limits_last_sync_at || null);
      if (window.RELOAD_STATIC) window.RELOAD_STATIC();
      await reload();
    } catch (_) {}
    setSyncing(false);
  };

  return (
    <section className="a-card">
      <div className="a-card-head">
        <h2>Limit reset times</h2>
        <span className="a-card-meta">{saving ? "saving…" : (loaded ? "override the dashboard's auto estimate" : "loading…")}</span>
      </div>
      <div className="a-budget-grid">
        <div className="a-budget-field">
          <div className="a-plan-title">Next 5h reset</div>
          <div className="a-plan-note">how long until your active 5h window resets</div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8, flexWrap: "wrap" }}>
            {[{ k: "h", label: "hours" }, { k: "m", label: "min" }].map((p) => (
              <label key={p.k} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                <input
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  className="a-text-input"
                  style={{ width: 64 }}
                  placeholder="0"
                  value={drafts.limits_five_hour_reset_at?.[p.k] ?? ""}
                  onChange={(e) => onPartChange(p.k, e.target.value)}
                  onBlur={onCommit5h}
                  onKeyDown={(e) => { if (e.key === "Enter") e.target.blur(); }}
                />
                <span className="a-card-meta" style={{ fontSize: 11 }}>{p.label}</span>
              </label>
            ))}
            {server.limits_five_hour_reset_at && (
              <button type="button" className="a-pill-btn" onClick={onClear5h}>Clear</button>
            )}
          </div>
          {server.limits_five_hour_reset_at && (
            <div className="a-card-meta" style={{ marginTop: 6 }}>
              → resets {_formatResolved(server.limits_five_hour_reset_at)}
            </div>
          )}
        </div>

        <label className="a-budget-field">
          <div className="a-plan-title">Next weekly reset</div>
          <div className="a-plan-note">datetime when your weekly window ends</div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8 }}>
            <input
              type="datetime-local"
              value={drafts.limits_weekly_reset_at}
              onChange={(e) => setDrafts((d) => ({ ...d, limits_weekly_reset_at: e.target.value }))}
              onBlur={onCommitWeekly}
              onKeyDown={(e) => { if (e.key === "Enter") e.target.blur(); }}
            />
            {server.limits_weekly_reset_at && (
              <button type="button" className="a-pill-btn" onClick={onClearWeekly}>Clear</button>
            )}
          </div>
        </label>
      </div>
      <div className="a-card-divider" />
      <div className="a-label" style={{ marginBottom: 8 }}>Sync from Anthropic (optional)</div>
      {!keySet ? (
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <input
            type="password"
            className="a-text-input"
            placeholder="sk-ant-…"
            autoComplete="off"
            value={apiKeyDraft}
            onChange={(e) => setApiKeyDraft(e.target.value)}
            style={{ flex: 1, minWidth: 240 }}
          />
          <button type="button" className="a-pill-btn" onClick={onSaveKey} disabled={!apiKeyDraft.trim()}>
            Save key
          </button>
        </div>
      ) : (
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <span className="a-card-meta">API key saved · stored locally</span>
          <button type="button" className="a-pill-btn" onClick={onForgetKey}>Forget</button>
          <button type="button" className="a-pill-btn" onClick={onSyncNow} disabled={syncing}>
            {syncing ? "syncing…" : "Sync now"}
          </button>
        </div>
      )}
      {lastSyncStatus && (
        <div
          className={`a-card-meta ${lastSyncStatus === "ok" ? "tone-good" : lastSyncStatus.startsWith("error") ? "tone-bad" : ""}`}
          style={{ marginTop: 8 }}
        >
          {lastSyncStatus === "ok" && `Synced ${lastSyncAt ? new Date(lastSyncAt).toLocaleString() : ""} — values populated above`}
          {lastSyncStatus === "unsupported" && "This account does not expose unified-window resets — use manual entry above."}
          {lastSyncStatus.startsWith("error") && `Sync failed: ${lastSyncStatus.slice(6)}`}
        </div>
      )}

      <div className="a-card-divider" />
      <div className="a-label" style={{ marginBottom: 8 }}>Calibrate caps from Anthropic statusbar</div>
      <div className="a-card-meta" style={{ marginBottom: 12 }}>
        Default caps are rough community estimates. To match what Claude Code shows, type the current <strong>% used</strong> from the Anthropic statusbar — the dashboard back-solves your real cap from observed usage. Re-calibrate whenever the dashboard drifts from the statusbar.
      </div>
      <div className="a-cal-grid">
        {[
          { window: "five_hour", prefKey: "limits_5h_cap_override", label: "5h window", hint: "5-hour limit" },
          { window: "weekly",    prefKey: "limits_weekly_cap_override", label: "Weekly window", hint: "Weekly · all models" },
        ].map((f) => {
          const live = liveLimits[f.window];
          const used = live?.used ?? 0;
          const dashPct = live ? (live.pct_used || 0) * 100 : 0;
          const cap = capOverrides[f.prefKey];
          return (
            <div key={f.window} className="a-cal-cell">
              <div className="a-cal-head">
                <span className="a-plan-title">{f.label}</span>
                <span className="a-cal-tag">{f.hint}</span>
              </div>
              <dl className="a-cal-stats">
                <div><dt>cap</dt><dd>{cap ? `${cap.toLocaleString()} tok` : (
                  <span className="a-card-meta">
                    pricing.json default{live?.cap ? ` · ${live.cap.toLocaleString()} tok` : ""}
                  </span>
                )}</dd></div>
                <div><dt>used</dt><dd>{used.toLocaleString()} tok</dd></div>
                <div><dt>dashboard reads</dt><dd className={dashPct >= 90 ? "tone-bad" : dashPct >= 70 ? "tone-warn" : ""}>{dashPct.toFixed(1)}% used</dd></div>
              </dl>
              <div className="a-cal-input-row">
                <label className="a-cal-input-label">
                  <span>% used per Anthropic</span>
                  <div className="a-cal-input">
                    <input
                      type="number"
                      min="0"
                      max="100"
                      step="0.1"
                      placeholder="e.g. 22"
                      value={pctDrafts[f.window]}
                      onChange={(e) => setPctDrafts((p) => ({ ...p, [f.window]: e.target.value }))}
                      onKeyDown={(e) => { if (e.key === "Enter") onCalibrate(f.window); }}
                    />
                    <span className="a-cal-input-suffix">%</span>
                  </div>
                </label>
                <div className="a-cal-actions">
                  <button
                    type="button"
                    className="a-pill-btn"
                    onClick={() => onCalibrate(f.window)}
                    disabled={calibrating || !pctDrafts[f.window]}
                  >
                    {calibrating ? "…" : "Calibrate"}
                  </button>
                  {cap && (
                    <button
                      type="button"
                      className="a-pill-btn"
                      onClick={() => onClearCap(f.prefKey)}
                      disabled={calibrating}
                    >
                      Reset
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      {calibrateMsg && (
        <div className={`a-card-meta ${calibrateMsg.tone === "good" ? "tone-good" : "tone-bad"}`} style={{ marginTop: 8 }}>
          {calibrateMsg.text}
        </div>
      )}
    </section>
  );
};
