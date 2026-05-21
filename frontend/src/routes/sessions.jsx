import React, { useEffect, useMemo, useState } from "react";
import { D } from "../data-store.js";
import { fmtCost, fmtTokens } from "../format.js";
import { HBar, KPI, Label, ModelBadge } from "../components/atoms.jsx";
import { SortHeader, useSortable } from "../components/sortable.jsx";

const BANDS = [
  { from: 0,  to: 6,  label: "00:00–06:00" },
  { from: 6,  to: 12, label: "06:00–12:00" },
  { from: 12, to: 18, label: "12:00–18:00" },
  { from: 18, to: 24, label: "18:00–24:00" },
];
const WEEKEND = new Set(["Sat", "Sun"]);

const computeActivityStats = (rows) => {
  if (!rows || !rows.length) return null;
  const total = rows.reduce((a, r) => a + r.cells.reduce((s, v) => s + v, 0), 0);
  if (total === 0) return null;
  let bestDayBand = { day: rows[0].day, band: BANDS[0], sum: 0 };
  let bestHour    = { day: rows[0].day, h: 0, v: 0 };
  let quietHour   = { day: rows[0].day, h: 0, v: Infinity };
  let weekday = 0, weekend = 0;
  rows.forEach((row) => {
    const isWk = WEEKEND.has(row.day);
    BANDS.forEach((b) => {
      let s = 0;
      for (let h = b.from; h < b.to; h++) s += row.cells[h] || 0;
      if (s > bestDayBand.sum) bestDayBand = { day: row.day, band: b, sum: s };
    });
    row.cells.forEach((v, h) => {
      if (v > bestHour.v)  bestHour  = { day: row.day, h, v };
      if (v > 0 && v < quietHour.v) quietHour = { day: row.day, h, v };
      if (isWk) weekend += v; else weekday += v;
    });
  });
  return {
    total,
    bestDayBand,
    bestHour,
    quietHour: quietHour.v === Infinity ? null : quietHour,
    weekday, weekend,
    weekdayShare: weekday / total,
    weekendShare: weekend / total,
    bestShare: bestDayBand.sum / total,
  };
};

const fmtH = (h) => `${String(h).padStart(2, "0")}:00`;

const ActivitySidebar = ({ rows }) => {
  const s = computeActivityStats(rows);
  if (!s) return null;
  const peakPct = (s.bestShare * 100).toFixed(0);
  const wkPct   = (s.weekdayShare * 100).toFixed(0);
  const wePct   = (s.weekendShare * 100).toFixed(0);
  return (
    <aside className="a-actmap-side">
      <div className="a-actmap-side-kicker">your typical day</div>
      <div className="a-actmap-side-headline">
        <span className="a-actmap-side-headline-num">{peakPct}<span className="a-actmap-side-headline-unit">%</span></span>
        <span className="a-actmap-side-headline-tail">of weekly turns happen on <strong>{s.bestDayBand.day} {s.bestDayBand.band.label}</strong></span>
      </div>
      <dl className="a-actmap-side-list">
        <dt>weekday / weekend</dt>
        <dd>{wkPct}% / {wePct}%</dd>
        <dt>peak hour</dt>
        <dd>{s.bestHour.day} {fmtH(s.bestHour.h)} · {s.bestHour.v} turns</dd>
        {s.quietHour && (<>
          <dt>quietest active hour</dt>
          <dd>{s.quietHour.day} {fmtH(s.quietHour.h)} · {s.quietHour.v} turn{s.quietHour.v === 1 ? "" : "s"}</dd>
        </>)}
        <dt>total</dt>
        <dd>{s.total} turns</dd>
      </dl>
    </aside>
  );
};

const Heatmap = () => {
  const rows = D.heatmap || [];
  const max = Math.max(1, ...rows.flatMap((r) => r.cells));
  const cellBg = (v) =>
    v === 0
      ? "var(--panel-2)"
      : `color-mix(in oklab, var(--accent) ${Math.round((v / max) * 100)}%, transparent)`;
  return (
    <div className="a-heatmap">
      <div className="a-heatmap-axis-x">
        {[0, 6, 12, 18].map((h) => (
          <span
            key={h}
            className="a-heatmap-hour"
            style={{ gridColumn: `${h + 2} / span 6` }}
          >
            {`${h.toString().padStart(2, "0")}:00`}
          </span>
        ))}
      </div>
      {rows.map((row) => (
        <div key={row.day} className="a-heatmap-row">
          <span className="a-heatmap-day">{row.day}</span>
          {row.cells.map((v, h) => (
            <div key={h} className="a-heatmap-cell"
              title={`${row.day} ${h}:00 — ${v} turns`}
              style={{ background: cellBg(v) }} />
          ))}
        </div>
      ))}
      <div className="a-heatmap-legend">
        <span className="a-label">activity</span>
        <span className="a-heatmap-scale">
          {[0, 0.25, 0.5, 0.75, 1].map((v, i) => (
            <span key={i} style={{
              background: v === 0
                ? "var(--panel-2)"
                : `color-mix(in oklab, var(--accent) ${v * 100}%, transparent)`,
            }} />
          ))}
        </span>
        <span className="a-label">low → high</span>
      </div>
    </div>
  );
};

const billableForTurn = (m) =>
  (m.input_tokens || 0) + (m.output_tokens || 0)
  + (m.cache_create_5m_tokens || 0) + (m.cache_create_1h_tokens || 0);

const buildTurns = (rows, sessionCost) => {
  const out = [];
  let cur = null;
  let totalBillable = 0;
  for (const m of rows || []) {
    if (m.is_sidechain) continue;
    if (m.type === "user") {
      const text = (m.prompt_text || "").trim();
      if (!text) continue;
      if (cur) out.push(cur);
      cur = { n: out.length + 1, prompt: text, tokens: 0, tools: 0, billable: 0 };
      continue;
    }
    if (cur && m.type === "assistant") {
      const billable = billableForTurn(m);
      cur.tokens += billable + (m.cache_read_tokens || 0);
      cur.billable += billable;
      totalBillable += billable;
      try {
        const tc = m.tool_calls_json ? JSON.parse(m.tool_calls_json) : [];
        if (Array.isArray(tc)) cur.tools += tc.length;
      } catch (_) {}
    }
  }
  if (cur) out.push(cur);
  for (const t of out) {
    t.cost = totalBillable > 0 ? sessionCost * (t.billable / totalBillable) : 0;
  }
  return out;
};

const useSessionTurns = (selected) => {
  const [turns, setTurns] = useState([]);
  useEffect(() => {
    if (!selected || !selected.fullId) { setTurns([]); return; }
    let cancelled = false;
    fetch("/api/sessions/" + encodeURIComponent(selected.fullId))
      .then((r) => (r.ok ? r.json() : []))
      .then((rows) => {
        if (cancelled) return;
        setTurns(buildTurns(rows, selected.cost || 0));
      })
      .catch(() => { if (!cancelled) setTurns([]); });
    return () => { cancelled = true; };
  }, [selected && selected.fullId]);
  return turns;
};

const useFilteredSessions = (sessions, query, tagFilter) => useMemo(() => {
  const q = query.trim().toLowerCase();
  return sessions.filter((s) => {
    if (tagFilter && !(s.tags || []).includes(tagFilter)) return false;
    if (!q) return true;
    return (s.id || "").toLowerCase().includes(q)
      || (s.project || "").toLowerCase().includes(q)
      || (s.started || "").toLowerCase().includes(q)
      || (s.tags || []).some((t) => t.toLowerCase().includes(q));
  });
}, [sessions, query, tagFilter]);

const TagChips = ({ tags, onRemove }) => (
  <span className="a-tag-chips">
    {(tags || []).map((t) => (
      <span key={t} className="a-tag-chip" onClick={(e) => { e.stopPropagation(); onRemove && onRemove(t); }} title="click to remove">
        {t}
      </span>
    ))}
  </span>
);

const useStuckLoops = () => {
  const [byId, setById] = useState(new Map());
  useEffect(() => {
    let cancelled = false;
    fetch("/api/loops?days=30")
      .then((r) => (r.ok ? r.json() : []))
      .then((rows) => {
        if (cancelled) return;
        const m = new Map();
        for (const r of rows || []) {
          const list = m.get(r.session_id) || [];
          list.push(r);
          m.set(r.session_id, list);
        }
        setById(m);
      })
      .catch(() => { if (!cancelled) setById(new Map()); });
    return () => { cancelled = true; };
  }, []);
  return byId;
};

const LoopChip = ({ runs }) => {
  if (!runs || !runs.length) return null;
  const top = runs[0];
  const tip = `${top.tool_name} × ${top.count}${top.target ? ` on ${top.target}` : ""}`
    + (runs.length > 1 ? ` (+${runs.length - 1} more)` : "");
  return (
    <span
      className="a-tag-chip"
      title={tip}
      style={{ background: "var(--bad, #b33)", color: "var(--bone)" }}
    >
      🔁 {runs.length}
    </span>
  );
};

const SessionsList = ({ sessions, filtered, query, setQuery, selectedId, setSelectedId, allTags, tagFilter, setTagFilter, onExport, onMutateTags, loopsById }) => {
  const exportHref = `/api/export.csv${tagFilter ? `?tag=${encodeURIComponent(tagFilter)}` : ""}`;
  const { sorted, sortState, requestSort } = useSortable(filtered, null, "desc", {
    id: (r) => r.id,
    project: (r) => r.project,
    started: (r) => r.started,
    turns: (r) => r.turns || 0,
    tokens: (r) => r.tokens || 0,
    cost: (r) => r.cost || 0,
    firstPrompt: (r) => r.firstPrompt || "",
  });
  const headProps = { state: sortState, requestSort };
  return (
  <section className="a-card" style={{ marginBottom: 12 }}>
    <div className="a-card-head">
      <h2>Sessions</h2>
      <span className="a-card-meta" style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <select
          value={tagFilter || ""}
          onChange={(e) => setTagFilter(e.target.value || null)}
          className="a-search"
          style={{ minWidth: 110 }}
        >
          <option value="">all tags</option>
          {(allTags || []).map((t) => (
            <option key={t.tag} value={t.tag}>{t.tag} ({t.sessions})</option>
          ))}
        </select>
        <span className="a-search-prompt">
          <span className="a-search-prompt-glyph" aria-hidden="true">›</span>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="filter…"
            className="a-search"
          />
        </span>
        <a className="a-pill-btn" href={exportHref} download onClick={onExport}>export CSV</a>
        <span>{filtered.length}/{sessions.length}</span>
      </span>
    </div>
    <div className="a-scroll-5">
      <table className="a-table a-sticky-head">
        <thead>
          <tr>
            <SortHeader sortKey="id" {...headProps}>session</SortHeader>
            <SortHeader sortKey="project" {...headProps}>project</SortHeader>
            <SortHeader sortKey="started" {...headProps}>started</SortHeader>
            <SortHeader sortKey="turns" className="num" {...headProps}>turns</SortHeader>
            <SortHeader sortKey="tokens" className="num" {...headProps}>tokens</SortHeader>
            <SortHeader sortKey="cost" className="num" {...headProps}>cost</SortHeader>
            <th>tags</th>
            <SortHeader sortKey="firstPrompt" style={{ paddingLeft: 16 }} {...headProps}>first prompt</SortHeader>
          </tr>
        </thead>
        <tbody>
          {sorted.map((s) => (
            <tr key={s.id} className={`clickable ${selectedId === s.id ? "is-active" : ""}`} onClick={() => setSelectedId(s.id)}>
              <td className="mono" style={{ color: "var(--bone)" }}>{s.id}</td>
              <td className="muted">{s.project}</td>
              <td className="muted">{s.started}</td>
              <td className="num">{s.turns}</td>
              <td className="num">{fmtTokens(s.tokens)}</td>
              <td className="num tone-good">{fmtCost(s.cost)}</td>
              <td>
                <TagChips tags={s.tags} onRemove={(tag) => onMutateTags(s, { remove: [tag] })} />
                <LoopChip runs={loopsById && loopsById.get(s.fullId || s.id)} />
              </td>
              <td className="muted" style={{ paddingLeft: 16, maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={s.firstPrompt || ""}>
                {s.firstPrompt || "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  </section>
  );
};

const TagEditor = ({ tags, onAdd, onRemove }) => {
  const [draft, setDraft] = useState("");
  const submit = () => {
    const t = draft.trim();
    if (!t) return;
    onAdd(t);
    setDraft("");
  };
  return (
    <div className="a-tag-editor">
      <span className="a-label">tags</span>
      <TagChips tags={tags} onRemove={onRemove} />
      <input
        className="a-search"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
        placeholder="add tag…"
        style={{ minWidth: 140 }}
      />
      <button className="a-pill-btn" onClick={submit}>add</button>
    </div>
  );
};

const TURN_LIMITS = [
  { id: 10,   label: "10" },
  { id: 20,   label: "20" },
  { id: 50,   label: "50" },
  { id: 100,  label: "100" },
  { id: "all", label: "all" },
];

const SessionDetail = ({ selected, turns, onMutateTags }) => {
  const maxTurnTokens = Math.max(1, ...turns.map((x) => x.tokens));
  const avgPerTurn = fmtTokens(Math.floor((selected.tokens || 0) / Math.max(1, selected.turns)));
  const [limit, setLimit] = useState(10);
  const totalTurns = turns.length;
  const sliceCount = limit === "all" ? totalTurns : Math.min(limit, totalTurns);
  const visible = limit === "all" ? turns : turns.slice(0, limit);
  const isScrollable = sliceCount > 10;
  const { sorted: sortedTurns, sortState: turnSort, requestSort: requestTurnSort } = useSortable(visible, null, "desc", {
    n: (r) => r.n,
    prompt: (r) => r.prompt,
    tokens: (r) => r.tokens || 0,
    tools: (r) => r.tools || 0,
    cost: (r) => r.cost || 0,
  });
  const turnHeadProps = { state: turnSort, requestSort: requestTurnSort };
  return (
    <section className="a-card">
      <div className="a-card-head">
        <h2>{selected.id}</h2>
        <span className="a-card-meta">
          <ModelBadge model={selected.model} />
          <span style={{ marginLeft: 8 }}>{selected.project} · {selected.started} · {selected.turns} turns</span>
        </span>
      </div>
      <TagEditor
        tags={selected.tags}
        onAdd={(t) => onMutateTags(selected, { add: [t] })}
        onRemove={(t) => onMutateTags(selected, { remove: [t] })}
      />
      <div className="a-kpi-row a-kpi-row-tight">
        <KPI label="tokens" value={fmtTokens(selected.tokens)} />
        <KPI label="cost" value={fmtCost(selected.cost)} tone="good" />
        <KPI label="turns" value={(selected.turns || 0).toString()} />
        <KPI label="avg / turn" value={avgPerTurn} />
      </div>
      <div className="a-card-divider" />
      <div className="a-turn-toolbar">
        <Label>turn-by-turn</Label>
        <span className="a-turn-toolbar-meta">
          showing {sliceCount} of {totalTurns}
        </span>
        <div className="a-density" role="radiogroup" aria-label="turn limit">
          {TURN_LIMITS.map((opt) => (
            <button
              key={opt.id}
              type="button"
              role="radio"
              aria-checked={limit === opt.id}
              className={`a-density-btn ${limit === opt.id ? "is-on" : ""}`}
              onClick={() => setLimit(opt.id)}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>
      <div className={`a-table-scroll a-turn-scroll ${isScrollable ? "is-scrollable" : ""}`} style={{ marginTop: 8 }}>
        <table className="a-table a-turn-table a-sticky-head">
          <thead>
            <tr>
              <SortHeader sortKey="n" className="num" {...turnHeadProps}>#</SortHeader>
              <SortHeader sortKey="prompt" style={{ paddingLeft: 16 }} {...turnHeadProps}>prompt</SortHeader>
              <SortHeader sortKey="tokens" className="num" {...turnHeadProps}>tokens</SortHeader>
              <SortHeader sortKey="tools" className="num" {...turnHeadProps}>tools</SortHeader>
              <SortHeader sortKey="cost" className="num" {...turnHeadProps}>cost</SortHeader>
              <th style={{ paddingLeft: 16, width: 180 }}>distribution</th>
            </tr>
          </thead>
          <tbody>
            {sortedTurns.map((t) => (
              <tr key={t.n}>
                <td className="num mono">{t.n}</td>
                <td style={{ paddingLeft: 16, maxWidth: 380, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={t.prompt || ""}>
                  {(t.prompt || "—").replace(/\s+/g, " ").trim()}
                </td>
                <td className="num">{fmtTokens(t.tokens)}</td>
                <td className="num">{t.tools}</td>
                <td className="num tone-good">{fmtCost(t.cost)}</td>
                <td style={{ width: 180, paddingLeft: 16 }}><HBar value={t.tokens} max={maxTurnTokens} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
};

const sessionIdFromHash = () => {
  const raw = (window.location.hash || "").replace(/^#\/?/, "");
  const parts = raw.split("/");
  if ((parts[0] || "").toLowerCase() !== "sessions") return null;
  return parts[1] ? decodeURIComponent(parts[1]) : null;
};

const mutateTags = async (session, body) => {
  if (!session || !session.fullId) return null;
  try {
    const r = await fetch(`/api/sessions/${encodeURIComponent(session.fullId)}/tags`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) return null;
    return await r.json();
  } catch (_) { return null; }
};

export const Sessions = () => {
  const [revision, setRevision] = useState(0);
  const sessions = D.sessions || [];
  const allTags = D.tags || [];
  const [selectedId, setSelectedId] = useState(() => {
    const fromHash = sessionIdFromHash();
    if (fromHash && sessions.some((s) => s.id === fromHash)) return fromHash;
    return sessions[0] ? sessions[0].id : null;
  });
  const [query, setQuery] = useState("");
  const [tagFilter, setTagFilter] = useState(null);
  const selected = sessions.find((s) => s.id === selectedId) || sessions[0];
  const filtered = useFilteredSessions(sessions, query, tagFilter);
  const turns = useSessionTurns(selected);
  const loopsById = useStuckLoops();
  const onMutateTags = async (session, body) => {
    const resp = await mutateTags(session, body);
    if (resp && Array.isArray(resp.tags)) {
      // Optimistically update the in-memory session row so the UI reacts
      // before the next /api/sessions fetch lands.
      session.tags = resp.tags;
      setRevision((n) => n + 1);
      if (window.RELOAD_DATA) window.RELOAD_DATA();
    }
  };
  if (!selected) {
    return (
      <div className="a-route">
        <section className="a-card"><div className="muted">No sessions yet.</div></section>
      </div>
    );
  }
  return (
    <div className="a-route" data-rev={revision}>
      <section className="a-card" style={{ marginBottom: 12 }}>
        <div className="a-card-head">
          <h2>Activity heatmap</h2>
          <span className="a-card-meta">turns per hour · last 7 days · UTC</span>
        </div>
        <div className="a-actmap-grid">
          <Heatmap />
          <ActivitySidebar rows={D.heatmap || []} />
        </div>
      </section>
      <SessionsList
        sessions={sessions}
        filtered={filtered}
        query={query}
        setQuery={setQuery}
        selectedId={selectedId}
        setSelectedId={setSelectedId}
        allTags={allTags}
        tagFilter={tagFilter}
        setTagFilter={setTagFilter}
        onMutateTags={onMutateTags}
        loopsById={loopsById}
      />
      <SessionDetail selected={selected} turns={turns} onMutateTags={onMutateTags} />
    </div>
  );
};
