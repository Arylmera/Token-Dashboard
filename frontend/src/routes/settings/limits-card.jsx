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

const RESET_FIELDS = [
  { key: "limits_five_hour_reset_at", label: "Next 5h reset",     note: "datetime when your active 5h window ends" },
  { key: "limits_weekly_reset_at",    label: "Next weekly reset", note: "datetime when your weekly window ends" },
];

export const LimitResetCard = () => {
  const [drafts, setDrafts] = useState({ limits_five_hour_reset_at: "", limits_weekly_reset_at: "" });
  const [server, setServer] = useState({ limits_five_hour_reset_at: null, limits_weekly_reset_at: null });
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [keySet, setKeySet] = useState(false);
  const [lastSyncAt, setLastSyncAt] = useState(null);
  const [lastSyncStatus, setLastSyncStatus] = useState(null);
  const [syncing, setSyncing] = useState(false);

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
        limits_five_hour_reset_at: _isoToLocalInput(next.limits_five_hour_reset_at),
        limits_weekly_reset_at:    _isoToLocalInput(next.limits_weekly_reset_at),
      });
      setKeySet(!!d.anthropic_api_key_set);
      setLastSyncAt(d.limits_last_sync_at || null);
      setLastSyncStatus(d.limits_last_sync_status || null);
    } catch (_) {}
    setLoaded(true);
  };

  useEffect(() => { reload(); }, []);

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

  const onCommit = (key) => {
    const draft = drafts[key];
    const iso = draft ? _localInputToIso(draft) : null;
    if (iso === server[key]) return;
    persist(key, iso);
  };

  const onClear = (key) => {
    setDrafts((d) => ({ ...d, [key]: "" }));
    persist(key, null);
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
        {RESET_FIELDS.map((f) => (
          <label key={f.key} className="a-budget-field">
            <div className="a-plan-title">{f.label}</div>
            <div className="a-plan-note">{f.note}</div>
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8 }}>
              <input
                type="datetime-local"
                value={drafts[f.key]}
                onChange={(e) => setDrafts((d) => ({ ...d, [f.key]: e.target.value }))}
                onBlur={() => onCommit(f.key)}
                onKeyDown={(e) => { if (e.key === "Enter") e.target.blur(); }}
              />
              {server[f.key] && (
                <button type="button" className="a-pill-btn" onClick={() => onClear(f.key)}>
                  Clear
                </button>
              )}
            </div>
          </label>
        ))}
      </div>
      <div className="a-card-divider" />
      <div className="a-label" style={{ marginBottom: 8 }}>Sync from Anthropic (optional)</div>
      {!keySet ? (
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <input
            type="password"
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
    </section>
  );
};
