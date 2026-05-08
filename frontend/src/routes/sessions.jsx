import React, { useEffect, useMemo, useState } from "react";
import { D } from "../data-store.js";
import { fmtCost, fmtTokens } from "../format.js";
import { HBar, KPI, Label, ModelBadge } from "../components/atoms.jsx";

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
        <span></span>
        {Array.from({ length: 24 }).map((_, h) => (
          <span key={h} className="a-heatmap-hour">{h % 6 === 0 ? `${h.toString().padStart(2, "0")}:00` : ""}</span>
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
      if (cur) out.push(cur);
      cur = { n: out.length + 1, prompt: m.prompt_text || "", tokens: 0, tools: 0, billable: 0 };
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

const SessionsList = ({ sessions, filtered, query, setQuery, selectedId, setSelectedId, allTags, tagFilter, setTagFilter, onExport, onMutateTags }) => {
  const exportHref = `/api/export.csv${tagFilter ? `?tag=${encodeURIComponent(tagFilter)}` : ""}`;
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
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="search sessions…"
          className="a-search"
        />
        <a className="a-pill-btn" href={exportHref} download onClick={onExport}>export CSV</a>
        <span>{filtered.length}/{sessions.length}</span>
      </span>
    </div>
    <div className="a-scroll-5">
      <table className="a-table a-sticky-head">
        <thead>
          <tr>
            <th>session</th>
            <th>project</th>
            <th>started</th>
            <th className="num">turns</th>
            <th className="num">tokens</th>
            <th className="num">cost</th>
            <th>tags</th>
            <th style={{ paddingLeft: 16 }}>first prompt</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((s) => (
            <tr key={s.id} className={`clickable ${selectedId === s.id ? "is-active" : ""}`} onClick={() => setSelectedId(s.id)}>
              <td className="mono" style={{ color: "var(--bone)" }}>{s.id}</td>
              <td className="muted">{s.project}</td>
              <td className="muted">{s.started}</td>
              <td className="num">{s.turns}</td>
              <td className="num">{fmtTokens(s.tokens)}</td>
              <td className="num tone-good">{fmtCost(s.cost)}</td>
              <td><TagChips tags={s.tags} onRemove={(tag) => onMutateTags(s, { remove: [tag] })} /></td>
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

const SessionDetail = ({ selected, turns, onMutateTags }) => {
  const maxTurnTokens = Math.max(1, ...turns.map((x) => x.tokens));
  const avgPerTurn = fmtTokens(Math.floor((selected.tokens || 0) / Math.max(1, selected.turns)));
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
      <Label>turn-by-turn</Label>
      <div className="a-table-scroll" style={{ marginTop: 8 }}>
        <table className="a-table a-turn-table">
          <thead>
            <tr><th className="num">#</th><th style={{ paddingLeft: 16 }}>prompt</th><th className="num">tokens</th><th className="num">tools</th><th className="num">cost</th><th style={{ paddingLeft: 16, width: 180 }}>distribution</th></tr>
          </thead>
          <tbody>
            {turns.map((t) => (
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
        <Heatmap />
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
      />
      <SessionDetail selected={selected} turns={turns} onMutateTags={onMutateTags} />
    </div>
  );
};
