import React, { useState } from "react";
import { fmtTokens } from "../../format.js";

const toneFor = (pctUsed) => {
  if (pctUsed == null) return "";
  if (pctUsed >= 0.9) return "tone-bad";
  if (pctUsed >= 0.7) return "tone-warn";
  return "tone-good";
};

// Deliberately different from widget.jsx's variant — relative "resets in" phrasing.
const fmtResetIn = (resetsAt) => {
  if (!resetsAt) return null;
  const ms = new Date(resetsAt).getTime() - Date.now();
  if (!isFinite(ms) || ms <= 0) return null;
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `resets in ${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `resets in ${h}h` : `resets in ${h}h ${m}m`;
};

export const LimitWindow = ({ label, sub, win, plan }) => {
  if (!win) return null;
  const isServer = win.source === "server";
  if (isServer) {
    if (win.anchor == null) {
      return (
        <div className="a-limit">
          <div className="a-label">{label}</div>
          <div className="a-limit-num">—</div>
          <div className="a-strip-sub">{sub} · run “Sync now” in Settings to fetch live values</div>
        </div>
      );
    }
    const pctRem = (win.pct_remaining || 0) * 100;
    const pctUsed = (win.pct_used || 0) * 100;
    const tone = toneFor(win.pct_used);
    const resetIn = fmtResetIn(win.resets_at);
    const subText = resetIn ? `${sub} · ${resetIn} · live` : `${sub} · live`;
    return (
      <div className="a-limit">
        <div className="a-label">{label}</div>
        <div className={`a-limit-num ${tone}`}>≈{pctRem.toFixed(0)}%<span className="a-strip-unit">left</span></div>
        <div className="a-gauge">
          <div className="a-gauge-track">
            <div className={`a-gauge-fill ${tone}`} style={{ width: `${Math.min(pctUsed, 100)}%` }} />
          </div>
        </div>
        <div className="a-strip-sub">{subText}</div>
      </div>
    );
  }
  if (win.cap == null) {
    const hint = plan === "api"
      ? "no cap on API plan"
      : `no cap configured for "${plan}" — pick a Claude plan in Settings`;
    return (
      <div className="a-limit">
        <div className="a-label">{label}</div>
        <div className="a-limit-num">—</div>
        <div className="a-strip-sub">{sub} · {hint}</div>
      </div>
    );
  }
  const pctRem = (win.pct_remaining || 0) * 100;
  const pctUsed = (win.pct_used || 0) * 100;
  const tone = toneFor(win.pct_used);
  const resetIn = fmtResetIn(win.resets_at);
  const idle = "anchor" in win && win.anchor == null;
  const calBadge = win.calibrated ? " · calibrated" : "";
  const subText = idle
    ? `${sub} · idle — no active session`
    : resetIn
      ? `${fmtTokens(win.used)} / ${fmtTokens(win.cap)} tok · ${resetIn}${calBadge}`
      : `${fmtTokens(win.used)} / ${fmtTokens(win.cap)} tok · ${sub}${calBadge}`;
  return (
    <div className="a-limit">
      <div className="a-label">{label}</div>
      <div className={`a-limit-num ${tone}`}>≈{pctRem.toFixed(0)}%<span className="a-strip-unit">left</span></div>
      <div className="a-gauge">
        <div className="a-gauge-track">
          <div className={`a-gauge-fill ${tone}`} style={{ width: `${Math.min(pctUsed, 100)}%` }} />
        </div>
      </div>
      <div className="a-strip-sub">{subText}</div>
    </div>
  );
};

export const LimitsCard = ({ limits, enabled }) => {
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState(null);

  if (enabled === false) return null;
  if (!limits) return null;
  const isServer = limits.five_hour?.source === "server" || limits.weekly?.source === "server";
  if (!isServer && limits.plan === "api") return null;

  const meta = limits.meta || {};
  const verifiedSuffix = meta.last_verified
    ? ` · synced ${new Date(meta.last_verified).toLocaleString()}`
    : "";
  const bothCalibrated = limits.five_hour?.calibrated && limits.weekly?.calibrated;
  const anyCalibrated = limits.five_hour?.calibrated || limits.weekly?.calibrated;

  // Server-sourced freshness: we have a snapshot AND the last sync succeeded.
  // `last_sync_status` lives on the LimitsResponse alongside the snapshot.
  const lastStatus = limits.last_sync_status;
  const hasAnchor = !!(limits.five_hour?.anchor || limits.weekly?.anchor);
  const serverFresh = isServer && hasAnchor && (lastStatus === "ok" || lastStatus == null);
  const serverNeedsSync =
    isServer && (!hasAnchor || (lastStatus != null && lastStatus !== "ok"));
  // Surface the manual Sync button on the Overview when the last
  // successful snapshot is older than this — saves the user a trip to
  // Settings during long idle stretches (activity-triggered syncs need
  // fresh JSONL lines, so an idle dashboard goes stale).
  const STALE_AFTER_MS = 60 * 60 * 1000;
  const lastVerifiedMs = meta.last_verified ? Date.parse(meta.last_verified) : NaN;
  const serverStaleByAge =
    isServer && Number.isFinite(lastVerifiedMs) && Date.now() - lastVerifiedMs > STALE_AFTER_MS;

  const onSync = async () => {
    setSyncing(true);
    setSyncError(null);
    try {
      const r = await fetch("/api/limits/sync_oauth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setSyncError(d.error || `HTTP ${r.status}`);
      } else if (d.status === "ok") {
        setSyncError(null); // SSE event refreshes the card
      } else if (d.status === "unsupported") {
        setSyncError("This account doesn't expose unified-window rate-limit headers.");
      } else {
        setSyncError(String(d.status || "Sync failed").replace(/^error:/, "Sync failed: "));
      }
    } catch (_) {
      setSyncError("Sync request failed.");
    }
    setSyncing(false);
  };

  const defaultNote = isServer
    ? lastStatus && lastStatus.startsWith("error")
      ? `Last sync failed (${lastStatus.replace(/^error:/, "").trim()}). Click Sync to retry — if it keeps failing, run \`claude\` to refresh credentials.`
      : !hasAnchor
        ? "Click Sync to fetch live values from your Claude subscription."
        : "Live values from Anthropic rate-limit headers via your Claude subscription."
    : bothCalibrated
      ? "Caps calibrated from your Anthropic statusbar. Re-calibrate in Settings if your plan changes."
      : anyCalibrated
        ? "One window is calibrated; the other uses a rough community estimate. Calibrate the rest in Settings."
        : "Anthropic doesn't publish exact token caps; defaults are rough community estimates. Calibrate from your statusbar in Settings.";
  const note = (!isServer && meta.source_note) || defaultNote;
  const sub5h = isServer ? "5h window" : "anchored";
  const subWeek = isServer ? "7d window" : "last 7 days";
  const headMeta = isServer
    ? `live · Anthropic rate-limit headers${verifiedSuffix}`
    : `${limits.plan} plan · sonnet-equiv tokens${verifiedSuffix}`;

  // Banner + button visibility:
  // - JSONL source: keep the existing banner (cap-calibration advice).
  // - Server source + fresh: hide banner and button entirely — clean card.
  // - Server source + not fresh: show banner with action-oriented hint + Sync button.
  // - Server source + fresh but >1h old: show Sync button (no banner) so
  //   the user can refresh without leaving Overview.
  const showBanner = !serverFresh;
  const showSyncButton = isServer && (!serverFresh || serverStaleByAge);

  return (
    <section className="a-card a-limits">
      <div className="a-card-head">
        <h2>Plan limits remaining</h2>
        <span className="a-card-meta" style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span>{headMeta}</span>
          {showSyncButton && (
            <button
              type="button"
              className="a-pill-btn"
              onClick={onSync}
              disabled={syncing}
              title="Re-fetch live values from Anthropic"
            >
              {syncing ? "syncing…" : "↻ Sync"}
            </button>
          )}
        </span>
      </div>
      <div className="a-limits-grid">
        <LimitWindow label="5h session" sub={sub5h} win={limits.five_hour} plan={limits.plan} />
        <LimitWindow label="weekly window" sub={subWeek} win={limits.weekly} plan={limits.plan} />
      </div>
      {showBanner && <div className="a-limits-note">⚠ {note}</div>}
      {syncError && (
        <div className="a-limits-note tone-bad">⚠ {syncError}</div>
      )}
    </section>
  );
};
