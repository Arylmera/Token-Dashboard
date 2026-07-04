import React from "react";
import { D } from "../../data-store.js";
import { fmtCost } from "../../format.js";
import { KPI } from "../../components/atoms.jsx";
import { CountUp } from "../../components/count-up.jsx";

// Deliberately different from format.js fmtTokens — compact, one decimal.
const fmtTokensShort = (n) => {
  if (n == null || !isFinite(n)) return "—";
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return `${n}`;
};

export const BurnRateCard = () => {
  const br = D.burnRate;
  if (!br) return null;
  const daysLeft = br.days_remaining;
  // Only colour the countdown when running out is bad. weekly_reset is just
  // counting down to an automatic refresh, so a small number isn't urgent.
  const isAutoReset = br.cap_mode === "weekly_reset";
  const tone = daysLeft == null || isAutoReset ? ""
    : daysLeft < 3 ? "tone-bad"
    : daysLeft < 7 ? "tone-warn"
    : "tone-good";
  // Under 48h, hours are more meaningful than fractional days — switch
  // units so "0.4 days" reads as "10 h".
  const fmtDaysLeft = daysLeft == null ? "—"
    : daysLeft < 2 ? `${Math.max(0, Math.round(daysLeft * 24))} h`
    : daysLeft >= 99 ? "99+ days"
    : `${daysLeft.toFixed(1)} days`;

  // Subtitle + secondary KPI dispatch on cap_mode so each plan flavour
  // gets the projection that actually matches its constraint.
  let sub;
  let secondaryLabel = "hits zero";
  let secondaryValue = br.projected_exhaustion_date || "—";
  if (br.cap_mode === "weekly_tokens") {
    const used = br.weekly_used_tokens;
    const cap = br.weekly_cap_tokens;
    sub = `${fmtTokensShort(used)} / ${fmtTokensShort(cap)} sonnet-eq tokens this week`;
    secondaryLabel = "cap reached";
  } else if (br.cap_mode === "weekly_reset") {
    sub = `subscription plan · counting down to weekly window reset`;
    secondaryLabel = "window resets";
  } else if (br.cap_mode === "usd_monthly") {
    sub = `${fmtCost(br.mtd_cost_usd || 0)} of ${fmtCost(br.monthly_budget_usd)} this month`;
  } else {
    sub = br.plan === "api"
      ? "set a monthly budget in Settings to enable projection"
      : "weekly window idle · projection unavailable";
  }

  return (
    <div className="a-card a-burn-rate-compact">
      <div className="a-card-head">
        <h2>Burn rate</h2>
        <span className="a-card-meta">7-day average · {sub} · trend overlaid on Today</span>
      </div>
      <div className="a-kpi-row">
        <KPI label="avg / day" value={<CountUp to={br.avg_daily_cost_usd || 0} format={fmtCost} />} />
        <KPI label="days left" value={<span className={tone}>{fmtDaysLeft}</span>} />
        <KPI label={secondaryLabel} value={secondaryValue} />
      </div>
    </div>
  );
};
