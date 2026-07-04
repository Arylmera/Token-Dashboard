import React from "react";
import { D } from "../../data-store.js";
import { fmtCost, fmtTokens } from "../../format.js";
import { StripSpark } from "../../components/charts.jsx";
import { CountUp } from "../../components/count-up.jsx";

export const TopStrip = ({ totals, burn }) => {
  const burnSeries = (D.burnRate && Array.isArray(D.burnRate.daily_series))
    ? D.burnRate.daily_series.map((d) => d.cost_usd || 0)
    : null;
  return (
    <section className="a-strip">
      <div className="a-strip-left">
        <div className="a-label">today · live</div>
        <div className="a-strip-num"><CountUp to={totals.today || 0} format={fmtCost} /></div>
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
        <div className="a-strip-num">$<CountUp to={burn.rate || 0} format={(v) => v.toFixed(2)} /><span className="a-strip-unit">/hr</span></div>
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
