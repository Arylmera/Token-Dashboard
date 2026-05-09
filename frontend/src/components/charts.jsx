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
}) => {
  if (!data || data.length === 0) {
    return (
      <div className="a-chart-wrap" style={{ height }}>
        <div className="a-chart-empty" style={{ height }}>no data</div>
      </div>
    );
  }
  const max = Math.max(...data.map((d) => d.cost)) || 1;
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
  return (
    <div className="a-chart-wrap" style={{ position: "relative", height }}>
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
        <path d={area} fill={`url(#${gradId})`} />
        <path d={area} fill={`url(#${hatchId})`} />
        <path d={line} fill="none" stroke={accent} strokeWidth="0.6" vectorEffect="non-scaling-stroke" />
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

export const StripSpark = ({ data, accent = "var(--accent)", height = 38 }) => {
  if (!data || data.length === 0) return <div className="a-strip-spark" />;
  const max = Math.max(...data) || 1;
  const range = max || 1;
  const w = 100;
  const denom = Math.max(1, data.length - 1);
  const pts = data.map((v, i) => ({ x: (i / denom) * w, y: height - (v / range) * (height - 8) - 4 }));
  const line = smoothPath(pts);
  const area = `M0,${height - 4} L${line.slice(1)} L${w},${height - 4} Z`;
  const cursorX = w;
  const cursorY = height - (data[data.length - 1] / range) * (height - 8) - 4;
  const gid = randId("a-strip-grad");
  return (
    <svg viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" className="a-strip-spark">
      <defs>
        <linearGradient id={gid} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={accent} stopOpacity="0.3" />
          <stop offset="100%" stopColor={accent} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gid})`} />
      <path d={line} fill="none" stroke={accent} strokeWidth="0.8" vectorEffect="non-scaling-stroke" />
      <line x1={cursorX} y1="0" x2={cursorX} y2={height} stroke={accent} strokeWidth="0.4" opacity="0.6" />
      <circle cx={cursorX} cy={cursorY} r="1.4" fill={accent}>
        <animate attributeName="r" values="1.4;2.4;1.4" dur="2s" repeatCount="indefinite" />
      </circle>
    </svg>
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
  const topPad = 22;
  const botPad = 14;
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
  const ptAt = (i, isCache) => {
    const x = (i / denom) * w;
    const y = isCache ? yCache(data[i].cacheRead) : yCost(data[i].cost);
    return { x, y, xPct: (x / w) * 100, yPct: (y / height) * 100 };
  };

  const gradId = randId("a-dual-grad");
  const hatchId = randId("a-dual-hatch");
  return (
    <div className="a-chart-wrap" style={{ position: "relative", height }}>
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
        <path d={cacheArea} fill={`url(#${gradId})`} />
        <path d={cacheArea} fill={`url(#${hatchId})`} />
        <path d={cacheLine} fill="none" stroke={accent} strokeWidth="0.6" vectorEffect="non-scaling-stroke" />
        <path d={costLine}  fill="none" stroke="var(--bone)" strokeWidth="0.6" strokeDasharray="2 2" vectorEffect="non-scaling-stroke" opacity="0.85" />
        <circle cx={ptAt(cachePeak, true).x}  cy={ptAt(cachePeak, true).y}  r="1.2" fill={accent} />
        <circle cx={ptAt(costPeak, false).x}  cy={ptAt(costPeak, false).y}  r="1.2" fill="var(--bone)" />
      </svg>
      <div className="a-chart-annot" style={{
        position: "absolute",
        left: `${ptAt(cachePeak, true).xPct}%`,
        top: `calc(${ptAt(cachePeak, true).yPct}% - 16px)`,
        transform: ptAt(cachePeak, true).xPct > 80 ? "translate(-100%, 0)" : "translate(-50%, 0)",
        whiteSpace: "nowrap", pointerEvents: "none",
        font: '500 10px "JetBrains Mono"', color: "var(--gull)",
      }}>
        cache · {fmtTokensShort(data[cachePeak].cacheRead)}
      </div>
      <div className="a-chart-annot" style={{
        position: "absolute",
        left: `${ptAt(costPeak, false).xPct}%`,
        top: `calc(${ptAt(costPeak, false).yPct}% + 6px)`,
        transform: ptAt(costPeak, false).xPct > 80 ? "translate(-100%, 0)" : "translate(-50%, 0)",
        whiteSpace: "nowrap", pointerEvents: "none",
        font: '500 10px "JetBrains Mono"', color: "var(--bone)",
      }}>
        cost · {fmtDollars(data[costPeak].cost)}
      </div>
      <div className="a-chart-yaxis-l">{fmtTokensShort(cacheMax)}</div>
      <div className="a-chart-yaxis-r">{fmtDollars(costMax)}</div>
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
