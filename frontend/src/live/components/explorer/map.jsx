import React, { useState, useMemo, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { RadialForceLayout, HierarchicalLayout } from "../../lib/layout";
import { vaultPathStore } from "../../stores/vault-store.js";
import { linksToGraph } from "../../lib/linksGraph";
import { openNote } from "../../stores/explorer-store.js";
import { layoutNameStore, setLayout } from "../../stores/settings.js";
import { useStore } from "../../stores/use-store.js";
import { useEffect } from "react";

const W = 1200, H = 860;
const strategies = {
  radial: new RadialForceLayout(),
  hierarchical: new HierarchicalLayout(),
};

const posMap = (nodes) => new Map(nodes.map((p) => [p.id, p]));
const folderColor = (f) =>
  (!f ? "var(--accent)" : `hsl(${(Array.from(f).reduce((a, c) => a + c.charCodeAt(0), 0) * 47) % 360},65%,62%)`);

const radiusOf = (w) => Math.min(26, 5 + Math.sqrt(w ?? 0) * 3);

export function MapView() {
  const vaultPath = useStore(vaultPathStore);
  const layoutName = useStore(layoutNameStore);

  const [linkNotes, setLinkNotes] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!vaultPath) { setLinkNotes([]); return; }
    let cancelled = false;
    setLoading(true);
    invoke("vault_links", { vaultPath })
      .then((res) => { if (!cancelled) setLinkNotes(res); })
      .catch(() => { if (!cancelled) setLinkNotes([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [vaultPath]);

  const graph = useMemo(() => linksToGraph(linkNotes ?? []), [linkNotes]);

  const neighbors = useMemo(() => {
    const m = new Map();
    const add = (a, b) => { (m.get(a) ?? m.set(a, new Set()).get(a)).add(b); };
    for (const e of graph.edges.values()) { add(e.source, e.target); add(e.target, e.source); }
    return m;
  }, [graph]);

  const base = useMemo(() => {
    const g = graph;
    const positioned = (strategies[layoutName] ?? strategies.radial).layout(g, W, H);
    const pos = posMap(positioned);
    let bx = 0, by = 0, bw = W, bh = H;
    if (positioned.length) {
      const xs = positioned.map((p) => p.x), ys = positioned.map((p) => p.y);
      const pad = 60, labelPad = 160;
      bx = Math.min(...xs) - pad; by = Math.min(...ys) - pad;
      bw = Math.max(...xs) + labelPad - bx; bh = Math.max(...ys) + pad - by;
    }
    return { g, pos, bx, by, bw, bh };
  }, [graph, layoutName]);

  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [hover, setHover] = useState(null);
  const svgRef = useRef(null);

  const reset = useCallback(() => { setZoom(1); setPan({ x: 0, y: 0 }); }, []);

  const dimmed = useCallback((id) => {
    if (!hover) return false;
    return id !== hover.id && !(neighbors.get(hover.id)?.has(id));
  }, [hover, neighbors]);

  const viewBox = useMemo(() => {
    const b = base;
    const w = b.bw / zoom, h = b.bh / zoom;
    const cx = b.bx + b.bw / 2 + pan.x, cy = b.by + b.bh / 2 + pan.y;
    return `${cx - w / 2} ${cy - h / 2} ${w} ${h}`;
  }, [base, zoom, pan]);

  const downRef = useRef(false);
  const movedRef = useRef(false);
  const lastRef = useRef({ x: 0, y: 0 });

  const onWheel = useCallback((e) => {
    e.preventDefault();
    const f = e.deltaY < 0 ? 1.2 : 1 / 1.2;
    setZoom((z) => Math.min(8, Math.max(0.3, z * f)));
  }, []);

  const onDown = useCallback((e) => {
    downRef.current = true;
    movedRef.current = false;
    lastRef.current = { x: e.clientX, y: e.clientY };
  }, []);

  const onMove = useCallback((e) => {
    if (!downRef.current || !svgRef.current) return;
    const { x: lx, y: ly } = lastRef.current;
    if (Math.abs(e.clientX - lx) + Math.abs(e.clientY - ly) > 3) movedRef.current = true;
    const r = svgRef.current.getBoundingClientRect();
    setZoom((z) => {
      const scale = (base.bw / z) / r.width;
      setPan((p) => ({
        x: p.x - (e.clientX - lx) * scale,
        y: p.y - (e.clientY - ly) * scale,
      }));
      return z;
    });
    lastRef.current = { x: e.clientX, y: e.clientY };
  }, [base]);

  const onUp = useCallback(() => { downRef.current = false; }, []);

  const nodeClick = useCallback((id) => {
    if (!movedRef.current) openNote(id);
  }, []);

  const edges = [...base.g.edges.values()];
  const nodes = [...base.g.nodes.values()];

  return (
    <div className="pr-map-wrap">
      <div className="pr-info-card pr-map-info">
        <h3>CARTOGRAPHICUM</h3>
        <p>Every note linked by <b><code>{"[[wikilinks]]"}</code></b>, parsed live — coloured by <b>folder</b>, sized by <b>link count</b>. Works on any vault.</p>
        <div className="pr-map-toggle">
          <button className={layoutName === "radial" ? "is-active" : ""} onClick={() => setLayout("radial")}>radial</button>
          <button className={layoutName === "hierarchical" ? "is-active" : ""} onClick={() => setLayout("hierarchical")}>hierarchical</button>
        </div>
        <div className="pr-info-meta" style={{ marginTop: "8px" }}>scroll = zoom · drag = pan · click a node to open · <a onClick={reset}>reset</a></div>
      </div>
      {(linkNotes ?? []).length ? (
        <svg ref={svgRef} width="100%" height="100%" viewBox={viewBox} preserveAspectRatio="xMidYMid meet"
          style={{ cursor: "grab", touchAction: "none" }}
          onWheel={onWheel} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={onUp}>
          {edges.map((e) => {
            const a = base.pos.get(e.source);
            const b = base.pos.get(e.target);
            if (!a || !b) return null;
            const dim = dimmed(e.source) && dimmed(e.target);
            return (
              <line key={e.id}
                x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                stroke="var(--border)" strokeWidth="1" opacity={dim ? 0.1 : 0.7} />
            );
          })}
          {nodes.map((n) => {
            const p = base.pos.get(n.id);
            if (!p) return null;
            const r = radiusOf(n.weight);
            const isDimmed = dimmed(n.id);
            const showLabel = r >= 7 || hover?.id === n.id;
            return (
              <g key={n.id}
                style={{ cursor: "pointer", opacity: isDimmed ? 0.15 : 1 }}
                onClick={() => nodeClick(n.id)}
                onMouseEnter={(e) => setHover({ x: e.clientX, y: e.clientY, id: n.id, title: n.label })}
                onMouseMove={(e) => setHover({ x: e.clientX, y: e.clientY, id: n.id, title: n.label })}
                onMouseLeave={() => setHover(null)}>
                <circle cx={p.x} cy={p.y} r={r} fill="var(--panel)" stroke={folderColor(n.session)} strokeWidth="2" />
                {showLabel && (
                  <text x={p.x + r + 4} y={p.y + 4} fill="var(--fg)" style={{ fontSize: "11px" }}>{n.label}</text>
                )}
              </g>
            );
          })}
        </svg>
      ) : (
        <div style={{ padding: "14px", color: "var(--gull)" }}>No linked notes in this vault.</div>
      )}
      {loading && (
        <div style={{ position: "absolute", bottom: "12px", left: "12px", color: "var(--gull-2)", fontSize: "11px", fontFamily: "var(--font-mono)" }}>building graph…</div>
      )}
      {hover && (
        <div className="pr-tooltip" style={{ left: `${hover.x + 14}px`, top: `${hover.y + 14}px` }}>
          {hover.title}
          <span className="sub">{hover.id}</span>
        </div>
      )}
    </div>
  );
}
