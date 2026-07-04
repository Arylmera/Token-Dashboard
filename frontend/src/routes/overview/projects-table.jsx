import React from "react";
import { D } from "../../data-store.js";
import { fmtCost, fmtTokens } from "../../format.js";
import { HBar } from "../../components/atoms.jsx";
import { SortHeader, useSortable } from "../../components/sortable.jsx";

export const ProjectsTable = ({ totals }) => {
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
