import React from "react";
import { D } from "../../data-store.js";
import { fmtCost, fmtTokens } from "../../format.js";
import { ModelBadge } from "../../components/atoms.jsx";
import { SortHeader, useSortable } from "../../components/sortable.jsx";
import { displayProject } from "../../project-name.js";

export const RecentSessions = ({ tc }) => {
  const sessions = D.sessions || [];
  const scroll = sessions.length > 20;
  const { sorted, sortState, requestSort } = useSortable(sessions, null, "desc", {
    id: (r) => r.id,
    project: (r) => displayProject(r.project),
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
          <SortHeader sortKey="id" {...headProps}>{tc?.col?.session ?? "session"}</SortHeader>
          <SortHeader sortKey="project" {...headProps}>project</SortHeader>
          <SortHeader sortKey="started" {...headProps}>started</SortHeader>
          <SortHeader sortKey="model" {...headProps}>{tc?.col?.model ?? "model"}</SortHeader>
          <SortHeader sortKey="turns" className="num" {...headProps}>turns</SortHeader>
          <SortHeader sortKey="tokens" className="num" {...headProps}>tokens</SortHeader>
          <SortHeader sortKey="cost" className="num" {...headProps}>cost</SortHeader>
        </tr>
      </thead>
      <tbody>
        {sorted.map((s) => (
          <tr key={s.id} className="clickable" onClick={() => { window.location.hash = `/sessions/${encodeURIComponent(s.id)}`; }}>
            <td className="mono">{s.id}</td>
            <td className="mono" title={s.project}>{displayProject(s.project)}</td>
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
        <h2>{tc?.card?.["Recent sessions"] ?? "Recent sessions"}</h2>
        <span className="a-card-meta">
          {scroll ? `${sessions.length} sessions · scroll for more` : "click a row to drill in"}
        </span>
      </div>
      {scroll ? <div className="a-recent-scroll">{table}</div> : table}
    </section>
  );
};
