import React from "react";

// Catmull-Rom → cubic Bezier; tension 0..1 (lower = smoother).
const smoothPath = (pts, tension = 0.5) => {
  if (pts.length === 0) return "";
  if (pts.length === 1) return `M${pts[0].x},${pts[0].y}`;
  let d = `M${pts[0].x},${pts[0].y}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] || p2;
    const c1x = p1.x + ((p2.x - p0.x) / 6) * tension * 2;
    const c1y = p1.y + ((p2.y - p0.y) / 6) * tension * 2;
    const c2x = p2.x - ((p3.x - p1.x) / 6) * tension * 2;
    const c2y = p2.y - ((p3.y - p1.y) / 6) * tension * 2;
    d += ` C${c1x},${c1y} ${c2x},${c2y} ${p2.x},${p2.y}`;
  }
  return d;
};

const randId = (prefix) => `${prefix}-${Math.random().toString(36).slice(2, 7)}`;

export const AreaChart = ({
  data,
  height = 200,
  accent = "var(--accent)",
  annotate = false,
  format = (v) => `$${v.toFixed(2)}`,
  guidelineY = null,
  guidelineLabel = null,
  guidelineAccent = "var(--warn)",
  /** Optional second series rendered as a dashed line (no fill). Same
   *  length and same x-spacing as `data`. */
  overlaySeries = null,
  overlayAccent = "var(--warn)",
  /** Override the auto-computed y-axis ceiling. Useful when the series is
   *  normalised to 0..1 and a hard 1.0 ceiling reads better than the
   *  data peak. */
  yMax = null,
  /** Optional y-axis tick values (array of numbers in series-value space).
   *  When provided, gridlines + labels render at each tick. */
  yTicks = null,
  yFormat = null,
}) => {
  if (!data || data.length === 0) {
    return (
      <div className="a-chart-wrap" style={{ height }}>
        <div className="a-chart-empty" style={{ height }}>no data</div>
      </div>
    );
  }
  // Share the y-axis between the main series, the optional overlay, and
  // the guideline so an on-pace line (or a second series with bigger
  // peaks) still gets drawn inside the viewport.
  const seriesMax = Math.max(...data.map((d) => d.cost)) || 1;
  const overlayMax = Array.isArray(overlaySeries) && overlaySeries.length > 0
    ? Math.max(...overlaySeries) || 0
    : 0;
  const max = yMax != null
    ? yMax
    : Math.max(seriesMax, overlayMax, guidelineY != null && guidelineY > 0 ? guidelineY : 0);
  const w = 100;
  const topPad = 22;
  const botPad = 14;
  const yOf = (v) => height - (v / max) * (height - topPad - botPad) - botPad;
  const pts = data.map((d, i) => ({ x: (i / Math.max(1, data.length - 1)) * w, y: yOf(d.cost) }));
  const line = smoothPath(pts);
  const area = `M0,${height - botPad} L${line.slice(1)} L${w},${height - botPad} Z`;
  const peakIdx = data.reduce((mi, d, i) => (d.cost > data[mi].cost ? i : mi), 0);
  const troughIdx = data.reduce((mi, d, i) => (d.cost < data[mi].cost ? i : mi), 0);
  const ptAt = (i) => {
    const x = (i / Math.max(1, data.length - 1)) * w;
    const y = yOf(data[i].cost);
    return { x, y, xPct: (x / w) * 100, yPct: (y / height) * 100 };
  };
  const gradId = randId("a-area-grad");
  const hatchId = randId("a-area-hatch");
  const guidelineYpx = guidelineY != null && guidelineY > 0 ? yOf(guidelineY) : null;
  const guidelineYpct = guidelineYpx != null ? (guidelineYpx / height) * 100 : null;
  const ticks = Array.isArray(yTicks) && yTicks.length > 0 ? yTicks : null;
  const fmtTick = yFormat || ((v) => `${v}`);
  const wrapPadLeft = ticks ? 44 : 0;
  return (
    <div className="a-chart-wrap" style={{ position: "relative", height, paddingLeft: wrapPadLeft }}>
      <svg viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" className="a-chart" style={{ height: "100%" }}>
        <defs>
          <linearGradient id={gradId} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={accent} stopOpacity="0.22" />
            <stop offset="100%" stopColor={accent} stopOpacity="0" />
          </linearGradient>
          <pattern id={hatchId} width="2" height="2" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="2" stroke={accent} strokeWidth="0.4" opacity="0.35" />
          </pattern>
        </defs>
        {ticks && ticks.map((t, i) => (
          <line
            key={`grid-${i}`}
            x1="0"
            x2={w}
            y1={yOf(t)}
            y2={yOf(t)}
            stroke="var(--iron-border)"
            strokeWidth="0.3"
            opacity="0.5"
            vectorEffect="non-scaling-stroke"
          />
        ))}
        <path d={area} fill={`url(#${gradId})`} />
        <path d={area} fill={`url(#${hatchId})`} />
        <path d={line} fill="none" stroke={accent} strokeWidth="0.6" vectorEffect="non-scaling-stroke" />
        {Array.isArray(overlaySeries) && overlaySeries.length > 0 && (
          <path
            d={smoothPath(overlaySeries.map((v, i) => ({
              x: (i / Math.max(1, overlaySeries.length - 1)) * w,
              y: yOf(v),
            })))}
            fill="none"
            stroke={overlayAccent}
            strokeWidth="0.5"
            strokeDasharray="2 2"
            opacity="0.9"
            vectorEffect="non-scaling-stroke"
          />
        )}
        {guidelineYpx != null && (
          <line
            x1="0"
            x2={w}
            y1={guidelineYpx}
            y2={guidelineYpx}
            stroke={guidelineAccent}
            strokeWidth="0.5"
            strokeDasharray="2 2"
            opacity="0.85"
            vectorEffect="non-scaling-stroke"
          />
        )}
        {annotate && data.length > 2 && [peakIdx, troughIdx].map((i, k) => {
          const p = ptAt(i);
          const above = k === 0;
          return (
            <g key={k}>
              <circle cx={p.x} cy={p.y} r="1.2" fill={accent} />
              <line x1={p.x} y1={p.y} x2={p.x} y2={above ? p.y - 6 : p.y + 6} stroke={accent} strokeWidth="0.3" vectorEffect="non-scaling-stroke" />
            </g>
          );
        })}
      </svg>
      {ticks && ticks.map((t, i) => {
        const yPct = (yOf(t) / height) * 100;
        return (
          <div
            key={`tick-${i}`}
            style={{
              position: "absolute",
              left: 0,
              width: wrapPadLeft - 6,
              top: `calc(${yPct}% - 6px)`,
              textAlign: "right",
              color: "var(--gull)",
              font: '500 10px "JetBrains Mono"',
              pointerEvents: "none",
            }}
          >
            {fmtTick(t)}
          </div>
        );
      })}
      {guidelineYpct != null && guidelineLabel && (
        <div
          className="a-chart-guideline-label"
          style={{
            position: "absolute",
            right: 4,
            top: `calc(${guidelineYpct}% - 14px)`,
            color: guidelineAccent,
            font: '500 10px "JetBrains Mono"',
            pointerEvents: "none",
          }}
        >
          {guidelineLabel}
        </div>
      )}
      {annotate && data.length > 2 && [peakIdx, troughIdx].map((i, k) => {
        const p = ptAt(i);
        const above = k === 0;
        const tx = p.xPct > 80 ? "translate(-100%, 0)" : p.xPct < 20 ? "translate(0, 0)" : "translate(-50%, 0)";
        return (
          <div key={k} className="a-chart-annot" style={{
            position: "absolute",
            left: `${p.xPct}%`,
            top: above ? `calc(${p.yPct}% - 16px)` : `calc(${p.yPct}% + 8px)`,
            transform: tx,
            whiteSpace: "nowrap",
            pointerEvents: "none",
            font: '500 10px "JetBrains Mono"',
            color: "var(--gull)",
          }}>
            {data[i].date} · {format(data[i].cost)}
          </div>
        );
      })}
    </div>
  );
};

export const StripSpark = ({
  data,
  accent = "var(--accent)",
  height = 38,
  overlayData = null,
  overlayAccent = "var(--warn)",
}) => {
  if (!data || data.length === 0) return <div className="a-strip-spark" />;
  const w = 100;
  // The primary series ("today · hourly") and the overlay ("burn · 7d
  // daily") live on different magnitudes — a daily total dwarfs any single
  // hour — so a shared axis flattens today into a baseline sliver. Scale
  // each series to its own max instead: today fills the chart height and
  // its shape reads clearly, and the overlay keeps its own trend.
  const overlay = Array.isArray(overlayData) && overlayData.length > 0 ? overlayData : null;
  const dataMax = Math.max(...data, 0.0001) || 1;
  const overlayMax = overlay ? Math.max(...overlay, 0.0001) || 1 : dataMax;
  const denom = Math.max(1, data.length - 1);
  const pts = data.map((v, i) => ({ x: (i / denom) * w, y: height - (v / dataMax) * (height - 8) - 4 }));
  const line = smoothPath(pts);
  const area = `M0,${height - 4} L${line.slice(1)} L${w},${height - 4} Z`;
  const cursorY = height - (data[data.length - 1] / dataMax) * (height - 8) - 4;
  const dotTopPct = (cursorY / height) * 100;
  const gid = randId("a-strip-grad");

  let overlayLine = null;
  if (overlay) {
    const odenom = Math.max(1, overlay.length - 1);
    const opts = overlay.map((v, i) => ({
      x: (i / odenom) * w,
      y: height - (v / overlayMax) * (height - 8) - 4,
    }));
    overlayLine = smoothPath(opts);
  }

  return (
    <div className="a-strip-spark">
      <svg viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" className="a-strip-spark-svg">
        <defs>
          <linearGradient id={gid} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={accent} stopOpacity="0.3" />
            <stop offset="100%" stopColor={accent} stopOpacity="0" />
          </linearGradient>
        </defs>
        {overlayLine && (
          <path
            d={overlayLine}
            fill="none"
            stroke={overlayAccent}
            strokeWidth="0.7"
            strokeDasharray="2 2"
            opacity="0.85"
            vectorEffect="non-scaling-stroke"
          />
        )}
        <path d={area} fill={`url(#${gid})`} />
        <path d={line} fill="none" stroke={accent} strokeWidth="0.8" vectorEffect="non-scaling-stroke" />
        <line x1={w} y1="0" x2={w} y2={height} stroke={accent} strokeWidth="0.4" opacity="0.6" vectorEffect="non-scaling-stroke" />
      </svg>
      <span className="a-strip-spark-dot" style={{ top: `${dotTopPct}%`, background: accent }} />
    </div>
  );
};

// Dual-series overlay: cache_read (filled area + hatch, left axis) and cost
// (dashed line, right axis). Accepts items with `cacheRead` (tokens) and
// `cost` ($). Annotates the peak of each series.
const fmtTokensShort = (n) => {
  if (n == null || !isFinite(n)) return "0";
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(1) + "b";
  if (a >= 1e6) return (n / 1e6).toFixed(1) + "m";
  if (a >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return String(Math.round(n));
};
const fmtDollars = (n) => `$${(n || 0).toFixed(2)}`;

export const DualAreaChart = ({ data, height = 220, accent = "var(--accent)" }) => {
  if (!data || data.length === 0) {
    return (
      <div className="a-chart-wrap" style={{ height }}>
        <div className="a-chart-empty" style={{ height }}>no data — run "token-dashboard scan"</div>
      </div>
    );
  }
  const w = 100;
  const topPad = 24;
  const botPad = 16;
  const padL = 44;
  const padR = 52;
  const cacheMax = Math.max(...data.map((d) => Number(d.cacheRead) || 0)) || 1;
  const costMax = Math.max(...data.map((d) => Number(d.cost) || 0)) || 1;
  const yCache = (v) => height - (v / cacheMax) * (height - topPad - botPad) - botPad;
  const yCost  = (v) => height - (v / costMax)  * (height - topPad - botPad) - botPad;
  const denom = Math.max(1, data.length - 1);
  const cachePts = data.map((d, i) => ({ x: (i / denom) * w, y: yCache(Number(d.cacheRead) || 0) }));
  const costPts  = data.map((d, i) => ({ x: (i / denom) * w, y: yCost(Number(d.cost) || 0) }));
  const cacheLine = smoothPath(cachePts);
  const cacheArea = `M0,${height - botPad} L${cacheLine.slice(1)} L${w},${height - botPad} Z`;
  const costLine  = smoothPath(costPts);

  const peakIdxOf = (key) => data.reduce((mi, d, i) => ((Number(d[key]) || 0) > (Number(data[mi][key]) || 0) ? i : mi), 0);
  const cachePeak = peakIdxOf("cacheRead");
  const costPeak  = peakIdxOf("cost");
  // Convert SVG viewBox coords to percentages of the wrapper (which spans
  // padL..padR of the wrapper, with the SVG sitting in that inner region).
  const innerWidthPct = 100; // SVG fills inner region; wrapper math handles offsets
  const ptAt = (i, isCache) => {
    const x = (i / denom) * w;
    const y = isCache ? yCache(data[i].cacheRead) : yCost(data[i].cost);
    return { x, y, xPct: (x / w) * innerWidthPct, yPct: (y / height) * 100 };
  };

  // Build tick rows: 5 horizontal grid lines (0/25/50/75/100%).
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  const gridY = ticks.map((t) => topPad + (1 - t) * (height - topPad - botPad));

  const gradId = randId("a-dual-grad");
  const hatchId = randId("a-dual-hatch");
  return (
    <div className="a-chart-wrap" style={{ position: "relative", height, paddingLeft: padL, paddingRight: padR, boxSizing: "border-box" }}>
      {/* Y axis labels — left (cache tokens) */}
      {ticks.map((t, idx) => (
        <div key={`yl-${idx}`} className="a-chart-ytick a-chart-ytick-l" style={{
          top: `${(gridY[idx] / height) * 100}%`,
        }}>{fmtTokensShort(cacheMax * t)}</div>
      ))}
      {/* Y axis labels — right (cost) */}
      {ticks.map((t, idx) => (
        <div key={`yr-${idx}`} className="a-chart-ytick a-chart-ytick-r" style={{
          top: `${(gridY[idx] / height) * 100}%`,
        }}>{fmtDollars(costMax * t)}</div>
      ))}
      <svg viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" className="a-chart" style={{ height: "100%", width: "100%" }}>
        <defs>
          <linearGradient id={gradId} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={accent} stopOpacity="0.22" />
            <stop offset="100%" stopColor={accent} stopOpacity="0" />
          </linearGradient>
          <pattern id={hatchId} width="2" height="2" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="2" stroke={accent} strokeWidth="0.4" opacity="0.35" />
          </pattern>
        </defs>
        {/* horizontal grid lines */}
        {gridY.map((gy, idx) => (
          <line key={`g-${idx}`} x1="0" y1={gy} x2={w} y2={gy}
            stroke="var(--iron-border)" strokeWidth="0.3"
            strokeDasharray={idx === ticks.length - 1 ? "" : "0.6 1.2"}
            vectorEffect="non-scaling-stroke" opacity="0.6" />
        ))}
        <path d={cacheArea} fill={`url(#${gradId})`} />
        <path d={cacheArea} fill={`url(#${hatchId})`} />
        <path d={cacheLine} fill="none" stroke={accent} strokeWidth="0.6" vectorEffect="non-scaling-stroke" />
        <path d={costLine}  fill="none" stroke="var(--bone)" strokeWidth="0.6" strokeDasharray="2 2" vectorEffect="non-scaling-stroke" opacity="0.85" />
      </svg>
      {/* HTML peak markers (avoid SVG circle stretch from preserveAspectRatio="none") */}
      <div className="a-chart-peak" style={{
        position: "absolute",
        left: `calc(${padL}px + (100% - ${padL + padR}px) * ${ptAt(cachePeak, true).xPct / 100})`,
        top: `${ptAt(cachePeak, true).yPct}%`,
        width: 6, height: 6, borderRadius: "50%",
        background: accent, transform: "translate(-50%, -50%)", pointerEvents: "none",
      }} />
      <div className="a-chart-peak" style={{
        position: "absolute",
        left: `calc(${padL}px + (100% - ${padL + padR}px) * ${ptAt(costPeak, false).xPct / 100})`,
        top: `${ptAt(costPeak, false).yPct}%`,
        width: 6, height: 6, borderRadius: "50%",
        background: "var(--bone)", transform: "translate(-50%, -50%)", pointerEvents: "none",
      }} />
      <div className="a-chart-annot" style={{
        position: "absolute",
        left: `calc(${padL}px + (100% - ${padL + padR}px) * ${ptAt(cachePeak, true).xPct / 100})`,
        top: `calc(${ptAt(cachePeak, true).yPct}% - 18px)`,
        transform: ptAt(cachePeak, true).xPct > 80 ? "translate(-100%, 0)" : (ptAt(cachePeak, true).xPct < 20 ? "translate(0, 0)" : "translate(-50%, 0)"),
        whiteSpace: "nowrap", pointerEvents: "none",
        font: '500 10px "JetBrains Mono"', color: "var(--gull)",
      }}>
        cache · {fmtTokensShort(data[cachePeak].cacheRead)}
      </div>
      <div className="a-chart-annot" style={{
        position: "absolute",
        left: `calc(${padL}px + (100% - ${padL + padR}px) * ${ptAt(costPeak, false).xPct / 100})`,
        top: `calc(${ptAt(costPeak, false).yPct}% + 8px)`,
        transform: ptAt(costPeak, false).xPct > 80 ? "translate(-100%, 0)" : (ptAt(costPeak, false).xPct < 20 ? "translate(0, 0)" : "translate(-50%, 0)"),
        whiteSpace: "nowrap", pointerEvents: "none",
        font: '500 10px "JetBrains Mono"', color: "var(--bone)",
      }}>
        cost · {fmtDollars(data[costPeak].cost)}
      </div>
    </div>
  );
};

export const Donut = ({ segments, size = 130, thickness = 14 }) => {
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  let acc = 0;
  return (
    <svg viewBox={`0 0 ${size} ${size}`} className="a-donut">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--iron-border)" strokeWidth={thickness} />
      {segments.map((s, i) => {
        const dash = c * s.value;
        const offset = c * (1 - acc);
        acc += s.value;
        return (
          <circle key={i} cx={size / 2} cy={size / 2} r={r} fill="none"
            stroke={s.color} strokeWidth={thickness}
            strokeDasharray={`${dash} ${c - dash}`}
            strokeDashoffset={offset}
            transform={`rotate(-90 ${size / 2} ${size / 2})`} />
        );
      })}
    </svg>
  );
};
