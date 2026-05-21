import React, { useState } from "react";
import { D } from "../data-store.js";
import { fmtCost, fmtCostWhole, fmtNum, fmtPct, fmtTokens } from "../format.js";
import { HBar, KPI, ModelBadge } from "../components/atoms.jsx";
import { AreaChart, Donut, DualAreaChart, StripSpark } from "../components/charts.jsx";
import { SortHeader, useSortable } from "../components/sortable.jsx";

const rangeDaysFromKey = (key) => {
  const k = String(key || "").toLowerCase();
  if (k === "all" || k === "alltime" || k === "all-time") return Infinity;
  if (k === "today" || k === "yesterday") return 1;
  const m = k.match(/^(\d+)\s*d/);
  if (m) return parseInt(m[1], 10);
  return 30;
};

const sparkOf = (daily, days, pick) => {
  const fn = pick || ((d) => Number(d.cost) || 0);
  const arr = (daily || []).map(fn);
  if (!arr.length) return null;
  const slice = Number.isFinite(days) ? arr.slice(-days) : arr;
  if (slice.length < 2) return null;
  return slice;
};

const KpiSpark = ({ daily, days, pick, accent }) => {
  const data = sparkOf(daily, days, pick);
  if (!data) return null;
  return (
    <div className="a-kpi-spark">
      <StripSpark data={data} height={22} accent={accent || "var(--accent)"} />
    </div>
  );
};

const cacheHitOf = (d) => {
  const reads = Number(d.cacheRead) || 0;
  const billed = (Number(d.input) || 0) + (Number(d.output) || 0);
  const total = reads + billed;
  return total > 0 ? reads / total : 0;
};

const KpiRow = ({ totals }) => {
  const t = totals;
  const daily = D.daily || [];
  const rangeDays = rangeDaysFromKey(t.rangeKey);
  // 1-day range only has a single daily bucket — fall back to the
  // 24-slot hourly series so input/output/cache-hit sparks have
  // enough points to draw a line.
  const useHourly = rangeDays === 1;
  const ioSeries = useHourly ? (D.hourlyDetail || []) : daily;
  const ioDays = useHourly ? 24 : rangeDays;
  const plusKey = t.plusKey || "all";
  const plusDays = rangeDaysFromKey(plusKey);
  const plusDaily = D.dailyPlus || daily;
  const plusUseHourly = plusDays === 1;
  const plusSparkData = plusUseHourly ? (D.hourlyDetail || []) : plusDaily;
  const plusSparkDays = plusUseHourly ? 24 : plusDays;
  const plusAvg = Number.isFinite(plusDays) && plusDays > 0
    ? `avg ${fmtCost((t.plusCost || 0) / plusDays)}/day`
    : `${fmtNum(t.turns)} turns`;
  const windows = [
    {
      key: "range",
      label: t.rangeLabel || "range",
      value: fmtCostWhole(t.range || 0),
      sub: `${fmtTokens(t.rangeTokens)} tok · ${t.rangeSessions || 0} sessions`,
      sparkData: useHourly ? (D.hourlyDetail || []) : daily,
      sparkDays: useHourly ? 24 : rangeDays,
    },
    {
      key: "plus",
      label: t.plusLabel || "plus",
      value: fmtCostWhole(t.plusCost || 0),
      sub: `${fmtTokens(t.plusTokens || 0)} tok · ${plusAvg}`,
      sparkData: plusSparkData,
      sparkDays: plusSparkDays,
    },
  ];
  return (
    <section className="a-kpi-row">
      {windows.map((w) => (
        <KPI
          key={w.key}
          label={w.label}
          value={w.value}
          sub={w.sub}
          spark={<KpiSpark daily={w.sparkData} days={w.sparkDays} />}
        />
      ))}
      <KPI
        label="input"
        value={fmtTokens(t.inputTokens)}
        sub={`tokens · ${t.rangeLabel || "range"}`}
        spark={<KpiSpark daily={ioSeries} days={ioDays} pick={(d) => Number(d.input) || 0} />}
      />
      <KPI
        label="output"
        value={fmtTokens(t.outputTokens)}
        sub={`tokens · ${t.rangeLabel || "range"}`}
        spark={<KpiSpark daily={ioSeries} days={ioDays} pick={(d) => Number(d.output) || 0} />}
      />
      <KPI
        label="cache hit"
        value={fmtPct(t.cacheHitRate)}
        sub={`last ${t.rangeLabel || "range"}`}
        spark={<KpiSpark daily={ioSeries} days={ioDays} pick={cacheHitOf} />}
      />
    </section>
  );
};

const BudgetAlertBanner = () => {
  const a = D.budgetAlerts;
  if (!a || !a.newly_crossed || a.newly_crossed.length === 0) return null;
  const max = Math.max(...a.newly_crossed);
  const tone = max >= 100 ? "tone-bad" : max >= 80 ? "tone-warn" : "tone-good";
  const label = max >= 100 ? "Monthly budget reached"
    : max >= 80 ? `${max}% of monthly budget consumed`
    : `${max}% of monthly budget consumed`;
  const detail = a.monthly_budget_usd != null
    ? `${fmtCost(a.mtd_cost_usd || 0)} of ${fmtCost(a.monthly_budget_usd)} (${(a.percent || 0).toFixed(0)}%)`
    : "";
  return (
    <div className={`a-banner ${tone}`}>
      <strong>{label}</strong>
      {detail && <span className="a-banner-detail"> · {detail}</span>}
    </div>
  );
};

const fmtTokensShort = (n) => {
  if (n == null || !isFinite(n)) return "—";
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return `${n}`;
};

const BurnRateCard = () => {
  const br = D.burnRate;
  if (!br) return null;
  const daysLeft = br.days_remaining;
  const tone = daysLeft == null ? ""
    : daysLeft < 3 ? "tone-bad"
    : daysLeft < 7 ? "tone-warn"
    : "tone-good";
  const fmtDaysLeft = daysLeft == null ? "—"
    : daysLeft < 1 ? "<1 day"
    : daysLeft >= 99 ? "99+ days"
    : `${daysLeft.toFixed(1)} days`;

  // Subtitle + secondary KPI dispatch on cap_mode so subscription users get
  // weekly-cap projection while API users keep the USD-budget readout.
  let sub;
  let secondaryLabel = "hits zero";
  let secondaryValue = br.projected_exhaustion_date || "—";
  if (br.cap_mode === "weekly_tokens") {
    const used = br.weekly_used_tokens;
    const cap = br.weekly_cap_tokens;
    sub = cap != null
      ? `${fmtTokensShort(used)} / ${fmtTokensShort(cap)} sonnet-eq tokens this week`
      : "weekly window — no cap configured";
    secondaryLabel = "cap reached";
    secondaryValue = br.projected_exhaustion_date || "—";
  } else if (br.cap_mode === "usd_monthly") {
    sub = `${fmtCost(br.mtd_cost_usd || 0)} of ${fmtCost(br.monthly_budget_usd)} this month`;
  } else {
    sub = br.plan === "api"
      ? "set a monthly budget in Settings to enable projection"
      : "weekly cap not configured for this plan";
  }

  return (
    <div className="a-card a-burn-rate-compact">
      <div className="a-card-head">
        <h2>Burn rate</h2>
        <span className="a-card-meta">7-day average · {sub} · trend overlaid on Today</span>
      </div>
      <div className="a-kpi-row">
        <KPI label="avg / day" value={fmtCost(br.avg_daily_cost_usd || 0)} />
        <KPI label="days left" value={<span className={tone}>{fmtDaysLeft}</span>} />
        <KPI label={secondaryLabel} value={secondaryValue} />
      </div>
    </div>
  );
};

const ChartAxis = ({ data, ticks = 7, insetLeft = 0, insetRight = 0 }) => {
  if (!data || data.length === 0) return null;
  const n = data.length;
  const count = Math.min(ticks, n);
  const idxs = count <= 1
    ? [0]
    : Array.from({ length: count }, (_, k) => Math.round((k * (n - 1)) / (count - 1)));
  const uniq = [...new Set(idxs)];
  return (
    <div className="a-chart-axis" style={{ paddingLeft: insetLeft, paddingRight: insetRight, position: "relative", height: 14 }}>
      {uniq.map((i, k) => {
        const pct = uniq.length === 1 ? 0 : (k / (uniq.length - 1)) * 100;
        const transform = k === 0 ? "translate(0, 0)" : (k === uniq.length - 1 ? "translate(-100%, 0)" : "translate(-50%, 0)");
        return (
          <span key={i} style={{
            position: "absolute",
            left: `calc(${insetLeft}px + (100% - ${insetLeft + insetRight}px) * ${pct / 100})`,
            top: 0, transform,
          }}>{data[i].date}</span>
        );
      })}
    </div>
  );
};

const toneFor = (pctUsed) => {
  if (pctUsed == null) return "";
  if (pctUsed >= 0.9) return "tone-bad";
  if (pctUsed >= 0.7) return "tone-warn";
  return "tone-good";
};

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

const LimitWindow = ({ label, sub, win, plan }) => {
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

const BUDGET_LABEL = { daily: "today", weekly: "this week", monthly: "this month" };

const BudgetBanner = ({ budget }) => {
  if (!budget) return null;
  const flagged = ["monthly", "weekly", "daily"]
    .map((k) => ({ key: k, ...(budget[k] || {}) }))
    .filter((w) => w.cap_usd != null && (w.status === "warn" || w.status === "over"));
  if (flagged.length === 0) return null;
  return (
    <section className="a-card" style={{ marginBottom: 12 }}>
      <div className="a-card-head">
        <h2>Budget alert</h2>
        <span className="a-card-meta">{flagged.length} window{flagged.length === 1 ? "" : "s"} flagged</span>
      </div>
      <div className="a-budget-banner-list">
        {flagged.map((w) => {
          const tone = w.status === "over" ? "tone-bad" : "tone-warn";
          const verb = w.status === "over" ? "over" : "trending over";
          return (
            <div key={w.key} className="a-budget-banner-row">
              <div className={`a-budget-banner-amt ${tone}`}>
                {fmtCost(w.used_usd)}<span className="a-strip-unit"> / {fmtCost(w.cap_usd)} {BUDGET_LABEL[w.key]}</span>
              </div>
              <div className="a-strip-sub">
                {verb} cap · projected {fmtCost(w.projected_usd)} by end of period
                · set caps in Settings
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
};

const PHASE_COLORS = {
  plan:    "var(--gull)",
  execute: "var(--accent)",
  other:   "var(--iron-border-2)",
};

const PhaseSplitCard = ({ phase }) => {
  if (!phase) return null;
  const total = (phase.plan?.billable_tokens || 0)
    + (phase.execute?.billable_tokens || 0)
    + (phase.other?.billable_tokens || 0);
  if (total === 0) return null;
  const seg = (k) => ({
    key: k,
    label: k,
    tokens: phase[k]?.billable_tokens || 0,
    cost: phase[k]?.cost_usd || 0,
    turns: phase[k]?.turns || 0,
    share: (phase[k]?.billable_tokens || 0) / total,
  });
  const segs = ["plan", "execute", "other"].map(seg);
  const planExec = (segs[0].tokens && segs[1].tokens)
    ? (segs[1].tokens / segs[0].tokens).toFixed(2)
    : null;
  return (
    <div className="a-card">
      <div className="a-card-head">
        <h2>Plan vs execute</h2>
        <span className="a-card-meta">
          billable tokens by phase{planExec ? ` · 1 : ${planExec} ratio` : ""}
        </span>
      </div>
      <div className="a-split-wrap">
        <div className="a-split-bar" role="img" aria-label="phase split">
          {segs.map((s) => (
            <div
              key={s.key}
              className={`a-split-seg a-split-seg-${s.key}`}
              style={{ flex: s.share || 0.0001, background: PHASE_COLORS[s.key] }}
              title={`${s.label} · ${fmtPct(s.share)}`}
            >
              {s.share >= 0.06 ? fmtPct(s.share) : ""}
            </div>
          ))}
        </div>
        <div className="a-split-meta">
          {segs.map((s) => (
            <div key={s.key} className="a-split-meta-cell">
              <div className={`a-split-meta-k a-split-meta-k-${s.key}`}>
                <span className="a-split-meta-sw" style={{ background: PHASE_COLORS[s.key] }} />
                {s.label}
              </div>
              <div className="a-split-meta-v">{fmtTokens(s.tokens)}</div>
              <div className="a-split-meta-s">{fmtCost(s.cost)} · {fmtNum(s.turns)} turns</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

const LimitsCard = ({ limits, enabled }) => {
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

const TopStrip = ({ totals, burn }) => {
  const burnSeries = (D.burnRate && Array.isArray(D.burnRate.daily_series))
    ? D.burnRate.daily_series.map((d) => d.cost_usd || 0)
    : null;
  return (
    <section className="a-strip">
      <div className="a-strip-left">
        <div className="a-label">today · live</div>
        <div className="a-strip-num">{fmtCost(totals.today)}</div>
        <div className="a-strip-sub">
          {fmtTokens(totals.todayTokens)} tok · vs {fmtCost(totals.yesterday)} yesterday · {totals.rangeSessions || 0} sessions·{totals.rangeKey || "30d"}
        </div>
      </div>
      <div className="a-strip-mid">
        <StripSpark
          data={D.hourly}
          overlayData={burnSeries}
          overlayAccent="var(--warn)"
          accent="var(--accent)"
          height={38}
        />
        <div className="a-strip-axis">
          <span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>now</span>
        </div>
        {burnSeries && (
          <div className="a-strip-legend">
            <span className="a-strip-legend-item"><span className="a-strip-legend-sw" style={{ background: "var(--accent)" }} /> today · hourly</span>
            <span className="a-strip-legend-item"><span className="a-strip-legend-sw a-strip-legend-sw-dashed" style={{ borderColor: "var(--warn)" }} /> burn · 7d daily</span>
          </div>
        )}
      </div>
      <div className="a-strip-right">
        <div className="a-label">burn rate</div>
        <div className="a-strip-num">${burn.rate.toFixed(2)}<span className="a-strip-unit">/hr</span></div>
        <div className="a-gauge">
          <div className="a-gauge-track">
            <div className="a-gauge-fill" style={{ width: `${Math.min(burn.multiple / 6, 1) * 100}%` }} />
            <div className="a-gauge-marker" style={{ left: `${(1 / 6) * 100}%` }} title="weekly avg" />
          </div>
          <div className="a-gauge-axis"><span>0×</span><span>1× avg</span><span>6×</span></div>
        </div>
        <div className="a-strip-sub tone-good">▲ {burn.multiple.toFixed(1)}× weekly avg</div>
      </div>
    </section>
  );
};

const DailyCharts = ({ totals }) => {
  const rangeDays = rangeDaysFromKey(totals.rangeKey);
  // 1-day range collapses to a single daily bucket — fall back to the
  // 24-slot hourly series so the cache×cost overlay actually draws a
  // curve instead of a flat segment between two duplicated points.
  const useHourly = rangeDays === 1;
  const series = useHourly ? (D.hourlyDetail || []) : (D.daily || []);
  const total = series.reduce((a, b) => a + (Number(b.cost) || 0), 0);
  return (
    <section className="a-card-row">
      <div className="a-card" style={{ gridColumn: "1 / -1" }}>
        <div className="a-card-head">
          <h2>Cache &times; cost</h2>
          <div className="a-chart-legend">
            <span className="a-chart-legend-item"><span className="a-chart-legend-sw" style={{ background: "var(--accent)" }} /> cache reads · tokens</span>
            <span className="a-chart-legend-item"><span className="a-chart-legend-sw a-chart-legend-sw-dashed" /> cost · USD</span>
            <span className="a-card-meta" style={{ marginLeft: 8 }}>last {totals.rangeLabel || "30 days"} · {fmtCost(total)} total · {fmtPct(totals.cacheHitRate)} hit</span>
          </div>
        </div>
        <DualAreaChart data={series} height={220} accent="var(--accent)" />
        <ChartAxis data={series} ticks={useHourly ? 5 : 7} insetLeft={44} insetRight={52} />
      </div>
    </section>
  );
};

const MODEL_COLORS = ["var(--bone)", "var(--accent)", "var(--gull)"];
const colorFor = (i) => MODEL_COLORS[i] || "var(--gull)";

const ProjectsTable = ({ totals }) => {
  const rows = (D.projects || []).slice(0, 7);
  const barMax = Math.max(1, ...rows.map((p) => p.cost || 0));
  const { sorted, sortState, requestSort } = useSortable(rows, "cost", "desc", {
    name: (r) => r.name,
    cost: (r) => r.cost || 0,
    tokens: (r) => r.tokens || 0,
    share: (r) => r.cost || 0,
  });
  const headProps = { state: sortState, requestSort };
  return (
    <div className="a-card a-projects-card">
      <div className="a-card-head"><h2>Tokens by project</h2></div>
      <table className="a-table">
        <thead><tr>
          <SortHeader sortKey="name" {...headProps}>project</SortHeader>
          <SortHeader sortKey="cost" className="num" {...headProps}>cost</SortHeader>
          <SortHeader sortKey="tokens" className="num" {...headProps}>tokens</SortHeader>
          <SortHeader sortKey="share" className="num" {...headProps}>share</SortHeader>
        </tr></thead>
        <tbody>
          {sorted.map((p) => (
            <tr key={p.slug}>
              <td>
                <div className="a-proj-nick">{p.name}</div>
                {p.slug && p.slug !== p.name && <div className="a-proj-slug">{p.slug}</div>}
              </td>
              <td className="num tone-good">{fmtCost(p.cost)}</td>
              <td className="num">{fmtTokens(p.tokens)}</td>
              <td className="num">
                <div className="a-bar-cell">
                  <HBar value={p.cost} max={barMax} />
                  <span>{((p.cost / (totals.cost || 1)) * 100).toFixed(1)}%</span>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

const CacheTrendCard = () => {
  const cs = D.cacheStats || { days: [], avg_7d: 0, avg_30d: 0 };
  const series = (cs.days || []).map((d) => d.hit_rate);
  const last = series.length ? series[series.length - 1] : 0;
  return (
    <div className="a-card">
      <div className="a-card-head">
        <h2>Cache hit rate</h2>
        <span className="a-card-meta">30-day trend</span>
      </div>
      <div className="a-kpi-row">
        <KPI label="7-day avg" value={fmtPct(cs.avg_7d)} />
        <KPI label="30-day avg" value={fmtPct(cs.avg_30d)} />
        <KPI label="latest day" value={fmtPct(last)} />
      </div>
      <StripSpark data={series.length ? series : [0]} accent="var(--accent)" />
    </div>
  );
};

const ModelsCard = () => (
  <div className="a-card">
    <div className="a-card-head"><h2>By model</h2></div>
    <div className="a-model-block">
      <Donut size={130} thickness={14} segments={(D.models || []).slice(0, 3).map((m, i) => ({
        value: m.share,
        color: colorFor(i),
      }))} />
      <div className="a-model-stack">
        {(D.models || []).map((m, i) => (
          <div key={m.name} className="a-model-legend">
            <span className="a-model-swatch" style={{ background: colorFor(i) }} />
            <span className="a-model-name">{m.short}</span>
            <span className="a-model-pct">{fmtPct(m.share)}</span>
            <span className="a-model-cost">{fmtCost(m.cost)}</span>
          </div>
        ))}
      </div>
    </div>
  </div>
);

const TopToolsCard = () => {
  const rows = (D.tools || []).slice(0, 5);
  const { sorted, sortState, requestSort } = useSortable(rows, "calls", "desc", {
    name: (r) => r.name,
    calls: (r) => r.calls || 0,
    tokens: (r) => r.tokens || 0,
  });
  const headProps = { state: sortState, requestSort };
  return (
    <div className="a-card">
      <div className="a-card-head">
        <h2>Top tools</h2>
        <span className="a-card-meta">most-used tools by call count</span>
      </div>
      <table className="a-table">
        <thead><tr>
          <SortHeader sortKey="name" {...headProps}>tool</SortHeader>
          <SortHeader sortKey="calls" className="num" {...headProps}>calls</SortHeader>
          <SortHeader sortKey="tokens" className="num" {...headProps}>tokens</SortHeader>
        </tr></thead>
        <tbody>
          {sorted.map((tool) => (
            <tr key={tool.name}>
              <td className="mono">{tool.name}</td>
              <td className="num">{fmtNum(tool.calls)}</td>
              <td className="num">{fmtTokens(tool.tokens)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

const RecentSessions = () => {
  const sessions = D.sessions || [];
  const scroll = sessions.length > 20;
  const { sorted, sortState, requestSort } = useSortable(sessions, null, "desc", {
    id: (r) => r.id,
    project: (r) => r.project,
    started: (r) => r.started,
    model: (r) => r.model,
    turns: (r) => r.turns || 0,
    tokens: (r) => r.tokens || 0,
    cost: (r) => r.cost || 0,
  });
  const headProps = { state: sortState, requestSort };
  const table = (
    <table className="a-table a-sticky-head">
      <thead>
        <tr>
          <SortHeader sortKey="id" {...headProps}>session</SortHeader>
          <SortHeader sortKey="project" {...headProps}>project</SortHeader>
          <SortHeader sortKey="started" {...headProps}>started</SortHeader>
          <SortHeader sortKey="model" {...headProps}>model</SortHeader>
          <SortHeader sortKey="turns" className="num" {...headProps}>turns</SortHeader>
          <SortHeader sortKey="tokens" className="num" {...headProps}>tokens</SortHeader>
          <SortHeader sortKey="cost" className="num" {...headProps}>cost</SortHeader>
        </tr>
      </thead>
      <tbody>
        {sorted.map((s) => (
          <tr key={s.id} className="clickable" onClick={() => { window.location.hash = `/sessions/${encodeURIComponent(s.id)}`; }}>
            <td className="mono">{s.id}</td>
            <td className="mono">{s.project}</td>
            <td>{s.started}</td>
            <td><ModelBadge model={s.model} /></td>
            <td className="num">{s.turns}</td>
            <td className="num">{fmtTokens(s.tokens)}</td>
            <td className="num tone-good">{fmtCost(s.cost)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
  return (
    <section className="a-card a-recent-sessions">
      <div className="a-card-head">
        <h2>Recent sessions</h2>
        <span className="a-card-meta">
          {scroll ? `${sessions.length} sessions · scroll for more` : "click a row to drill in"}
        </span>
      </div>
      {scroll ? <div className="a-recent-scroll">{table}</div> : table}
    </section>
  );
};

export const Overview = () => {
  const totals = D.totals;
  const burn = D.burn;
  return (
    <div className="a-route">
      <TopStrip totals={totals} burn={burn} />
      <BudgetAlertBanner />
      <BudgetBanner budget={D.budget} />
      <LimitsCard limits={D.limits} enabled={!!(D.prefs && D.prefs.limits_enabled)} />
      <BurnRateCard />
      <KpiRow totals={totals} />
      <DailyCharts totals={totals} />
      <section className="a-card-row">
        <ProjectsTable totals={totals} />
        <ModelsCard />
      </section>
      <section className="a-card-row">
        <PhaseSplitCard phase={D.phase} />
        <TopToolsCard />
      </section>
      <section className="a-card-row">
        <CacheTrendCard />
      </section>
      <RecentSessions />
    </div>
  );
};
