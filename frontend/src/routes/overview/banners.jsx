import React from "react";
import { D } from "../../data-store.js";
import { fmtCost } from "../../format.js";

/// Scanning runs unattended, so a broken scan looks exactly like a quiet
/// day — same numbers, no complaint. Say it out loud instead.
export const ScanErrorBanner = () => {
  const msg = D.scanError;
  if (!msg) return null;
  return (
    <div className="a-banner tone-bad">
      <strong>Scan failing — figures are frozen at the last good scan</strong>
      <span className="a-banner-detail"> · {msg}</span>
    </div>
  );
};

export const BudgetAlertBanner = () => {
  const a = D.budgetAlerts;
  if (!a) return null;
  const toneFor = (max) => max >= 100 ? "tone-bad" : max >= 80 ? "tone-warn" : "tone-good";
  const fmtReset = (iso) => iso ? iso.slice(0, 16).replace("T", " ") : "";
  const banners = [];
  if (a.subscription_mode) {
    if (a.newly_crossed_weekly && a.newly_crossed_weekly.length) {
      const max = Math.max(...a.newly_crossed_weekly);
      const label = max >= 100 ? "Weekly limit reached" : `${max}% of weekly limit consumed`;
      const used = a.weekly_percent != null ? `${a.weekly_percent.toFixed(0)}% used` : "";
      const resets = a.weekly_resets_at ? ` · resets ${fmtReset(a.weekly_resets_at)}` : "";
      banners.push({ key: "weekly", tone: toneFor(max), label, detail: used + resets });
    }
    if (a.newly_crossed_5h && a.newly_crossed_5h.length) {
      const max = Math.max(...a.newly_crossed_5h);
      const label = max >= 100 ? "5h window reached" : `${max}% of 5h window consumed`;
      const used = a.five_hour_percent != null ? `${a.five_hour_percent.toFixed(0)}% used` : "";
      const resets = a.five_hour_resets_at ? ` · resets ${fmtReset(a.five_hour_resets_at)}` : "";
      banners.push({ key: "five_hour", tone: toneFor(max), label, detail: used + resets });
    }
  } else if (a.newly_crossed && a.newly_crossed.length) {
    const max = Math.max(...a.newly_crossed);
    const label = max >= 100 ? "Monthly budget reached" : `${max}% of monthly budget consumed`;
    const detail = a.monthly_budget_usd != null
      ? `${fmtCost(a.mtd_cost_usd || 0)} of ${fmtCost(a.monthly_budget_usd)} (${(a.percent || 0).toFixed(0)}%)`
      : "";
    banners.push({ key: "monthly", tone: toneFor(max), label, detail });
  }
  if (banners.length === 0) return null;
  return (
    <>
      {banners.map((b) => (
        <div key={b.key} className={`a-banner ${b.tone}`}>
          <strong>{b.label}</strong>
          {b.detail && <span className="a-banner-detail"> · {b.detail}</span>}
        </div>
      ))}
    </>
  );
};

const BUDGET_LABEL = { daily: "today", weekly: "this week", monthly: "this month" };

export const BudgetBanner = ({ budget }) => {
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
