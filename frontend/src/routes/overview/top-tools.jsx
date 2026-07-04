import React from "react";
import { D } from "../../data-store.js";
import { fmtCost, fmtNum, fmtTokens } from "../../format.js";
import { SortHeader, useSortable } from "../../components/sortable.jsx";

export const TopToolsCard = () => {
  // Map cost lookup: { tool_name: attributed_cost_usd }. Combines the
  // existing /api/tools (call counts + result tokens) with /api/tool-costs
  // (attributed cost) so a single sortable row carries everything.
  const costMap = (D.toolCosts && D.toolCosts.tools)
    ? Object.fromEntries(D.toolCosts.tools.map((t) => [t.tool_name, t.attributed_cost_usd]))
    : {};
  const errorMap = (D.toolCosts && D.toolCosts.tools)
    ? Object.fromEntries(D.toolCosts.tools.map((t) => [t.tool_name, t.errors]))
    : {};
  const rows = (D.tools || []).slice(0, 8).map((r) => ({
    ...r,
    cost: costMap[r.name] || 0,
    errors: errorMap[r.name] || 0,
  }));
  const { sorted, sortState, requestSort } = useSortable(rows, "cost", "desc", {
    name: (r) => r.name,
    calls: (r) => r.calls || 0,
    tokens: (r) => r.tokens || 0,
    cost: (r) => r.cost || 0,
  });
  const headProps = { state: sortState, requestSort };
  return (
    <div className="a-card">
      <div className="a-card-head">
        <h2>Top tools</h2>
        <span className="a-card-meta">cost attributed via parent-message split · 30d</span>
      </div>
      <table className="a-table">
        <thead><tr>
          <SortHeader sortKey="name" {...headProps}>tool</SortHeader>
          <SortHeader sortKey="calls" className="num" {...headProps}>calls</SortHeader>
          <SortHeader sortKey="tokens" className="num" {...headProps}>tokens</SortHeader>
          <SortHeader sortKey="cost" className="num" {...headProps}>cost</SortHeader>
        </tr></thead>
        <tbody>
          {sorted.map((tool) => (
            <tr key={tool.name}>
              <td className="mono" title={tool.errors > 0 ? `${tool.errors} errors` : ""}>
                {tool.name}
                {tool.errors > 0 && <span className="a-error-dot" />}
              </td>
              <td className="num">{fmtNum(tool.calls)}</td>
              <td className="num">{fmtTokens(tool.tokens)}</td>
              <td className="num">{fmtCost(tool.cost || 0)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};
