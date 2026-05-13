import React, { useEffect, useState } from "react";
import { SettingRow } from "./atoms.jsx";

/// Combined enable-toggle + OAuth-sync card. Lives in the default
/// Settings tab (Pricing & budgets group). The OAuth-only path is the
/// only way the dashboard's 5h / weekly limits engine gets fed now —
/// the legacy manual-config card (reset times, API key, cap calibrator)
/// has been retired.
export const LimitsCard = ({ enabled, onChange, loaded, saving }) => {
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState(null);
  const [lastSyncAt, setLastSyncAt] = useState(null);
  const [lastSyncStatus, setLastSyncStatus] = useState(null);
  const [refreshTick, setRefreshTick] = useState(0);

  const reload = async () => {
    try {
      const r = await fetch("/api/preferences", { cache: "no-store" });
      const d = await r.json();
      setLastSyncAt(d.limits_last_sync_at || null);
      setLastSyncStatus(d.limits_last_sync_status || null);
    } catch (_) {}
  };

  useEffect(() => { reload(); }, [refreshTick]);

  // Pick up background syncs fired by the scanner hook.
  useEffect(() => {
    const onFocus = () => setRefreshTick((t) => t + 1);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

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
      } else if (d.status === "ok") {
        setSyncMsg({ tone: "good", text: "Synced — Overview will show live values." });
      } else if (d.status === "unsupported") {
        setSyncMsg({ tone: "bad", text: "Your account doesn't expose unified-window rate-limit headers." });
      } else {
        setSyncMsg({ tone: "bad", text: `Sync failed: ${(d.status || "").replace(/^error:/, "")}` });
      }
      if (window.RELOAD_STATIC) window.RELOAD_STATIC();
      setRefreshTick((t) => t + 1);
    } catch (_) {
      setSyncMsg({ tone: "bad", text: "Sync request failed." });
    }
    setSyncing(false);
  };

  const lastSyncFmt = lastSyncAt ? new Date(lastSyncAt).toLocaleString() : null;
  const statusLine = (() => {
    if (syncMsg) return syncMsg;
    if (lastSyncStatus === "ok" && lastSyncFmt)
      return { tone: "good", text: `Last sync ${lastSyncFmt}` };
    if (lastSyncStatus && lastSyncStatus.startsWith("error"))
      return { tone: "bad", text: `Last sync failed: ${lastSyncStatus.replace(/^error:/, "")}` };
    if (lastSyncStatus === "unsupported")
      return { tone: "bad", text: "Account doesn't expose unified-window rate-limit headers." };
    return null;
  })();

  return (
    <section className="a-card">
      <div className="a-card-head">
        <h2>Live limits</h2>
        <span className="a-card-meta">
          {saving ? "saving…" : loaded ? "5h + weekly windows via your Claude subscription" : "loading…"}
        </span>
      </div>
      <SettingRow
        title="Track 5h and weekly windows"
        description="Reads live utilization from Anthropic rate-limit headers via the OAuth token your `claude` login stored. Refreshes automatically when you use Claude Code (≈10 s cadence). macOS will prompt your Keychain on the first sync — click Always Allow to make later syncs silent. Experimental: undocumented Anthropic flow, may stop working without notice."
        checked={enabled}
        onChange={onChange}
      />
      {enabled && (
        <>
          <div className="a-card-divider" />
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <button type="button" className="a-pill-btn" onClick={onSync} disabled={syncing}>
              {syncing ? "syncing…" : "Sync now"}
            </button>
            <span className="a-card-meta">
              Forces an immediate refresh. Background sync handles steady state.
            </span>
          </div>
          {statusLine && (
            <div
              className={`a-card-meta ${statusLine.tone === "good" ? "tone-good" : "tone-bad"}`}
              style={{ marginTop: 8 }}
            >
              {statusLine.text}
            </div>
          )}
        </>
      )}
    </section>
  );
};
