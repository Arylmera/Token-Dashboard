import React, { useState } from "react";
import { D } from "../data-store.js";
import { fmtCost, fmtTokens } from "../format.js";
import { SortHeader, useSortable } from "../components/sortable.jsx";

const pctStyle = (v, max) => ({ "--pct": Math.min(100, Math.round(((v || 0) / (max || 1)) * 100)) });

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmtLastActive = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
};

const ProjectsTable = ({ rows, max }) => {
  const { sorted, sortState, requestSort } = useSortable(rows, "tokens", "desc", {
    name: (r) => r.name,
    lastActive: (r) => r.lastActive,
    sessions: (r) => r.sessions || 0,
    tokens: (r) => r.tokens || 0,
    cost: (r) => r.cost || 0,
  });
  const headProps = { state: sortState, requestSort };
  return (
    <div className="a-table-scroll">
      <table className="a-table a-sink-table">
        <thead><tr>
          <SortHeader sortKey="name" {...headProps}>project</SortHeader>
          <SortHeader sortKey="lastActive" {...headProps}>last active</SortHeader>
          <SortHeader sortKey="sessions" className="num" {...headProps}>sessions</SortHeader>
          <SortHeader sortKey="tokens" className="num" {...headProps}>tokens</SortHeader>
          <SortHeader sortKey="cost" className="num" {...headProps}>cost</SortHeader>
        </tr></thead>
        <tbody>
          {sorted.map((p) => (
            <tr key={p.slug} className="clickable has-bar" style={pctStyle(p.cost, max)}>
              <td>
                <div className="a-proj-nick">{p.name}</div>
                {p.slug && p.slug !== p.name && <div className="a-proj-slug">{p.slug}</div>}
              </td>
              <td className="muted">{fmtLastActive(p.lastActive)}</td>
              <td className="num">{p.sessions}</td>
              <td className="num">{fmtTokens(p.tokens)}</td>
              <td className="num tone-good">{fmtCost(p.cost)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

const SkillsTable = ({ rows }) => {
  const barMax = Math.max(1, ...rows.map((r) => r.tokens || 0));
  const { sorted, sortState, requestSort } = useSortable(rows, "tokens", "desc", {
    name: (r) => r.name,
    invocations: (r) => r.invocations || 0,
    tokens: (r) => r.tokens || 0,
    cost: (r) => r.cost || 0,
  });
  const headProps = { state: sortState, requestSort };
  return (
    <div className="a-table-scroll">
      <table className="a-table a-sink-table">
        <colgroup>
          <col />
          <col style={{ width: 110 }} />
          <col style={{ width: 130 }} />
          <col style={{ width: 110 }} />
        </colgroup>
        <thead><tr>
          <SortHeader sortKey="name" {...headProps}>skill</SortHeader>
          <SortHeader sortKey="invocations" className="num" {...headProps}>invocations</SortHeader>
          <SortHeader sortKey="tokens" className="num" {...headProps}>est. tokens</SortHeader>
          <SortHeader sortKey="cost" className="num" {...headProps}>est. cost</SortHeader>
        </tr></thead>
        <tbody>
          {sorted.map((s) => (
            <tr key={s.name} className="has-bar" style={pctStyle(s.tokens || 0, barMax)}>
              <td className="mono" style={{ color: "var(--bone)" }}>{s.name}</td>
              <td className="num">{s.invocations}</td>
              <td className="num muted">{s.tokens != null ? `~${fmtTokens(s.tokens)}` : "—"}</td>
              <td className="num tone-good">{s.cost != null ? `~${fmtCost(s.cost)}` : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

const SessionsTable = ({ rows, max }) => {
  const { sorted, sortState, requestSort } = useSortable(rows, "cost", "desc", {
    id: (r) => r.id,
    project: (r) => r.project,
    started: (r) => r.started,
    turns: (r) => r.turns || 0,
    tokens: (r) => r.tokens || 0,
    cost: (r) => r.cost || 0,
  });
  const headProps = { state: sortState, requestSort };
  return (
    <div className="a-table-scroll">
      <table className="a-table a-sink-table">
        <thead><tr>
          <SortHeader sortKey="id" {...headProps}>session</SortHeader>
          <SortHeader sortKey="project" {...headProps}>project</SortHeader>
          <SortHeader sortKey="started" {...headProps}>started</SortHeader>
          <SortHeader sortKey="turns" className="num" {...headProps}>turns</SortHeader>
          <SortHeader sortKey="tokens" className="num" {...headProps}>tokens</SortHeader>
          <SortHeader sortKey="cost" className="num" {...headProps}>cost</SortHeader>
        </tr></thead>
        <tbody>
          {sorted.map((s) => (
            <tr key={s.fullId || s.id} className="has-bar" style={pctStyle(s.cost, max)}>
              <td className="mono" style={{ color: "var(--bone)" }}>{s.id}</td>
              <td className="mono">{s.project}</td>
              <td className="muted">{s.started}</td>
              <td className="num">{s.turns}</td>
              <td className="num">{fmtTokens(s.tokens)}</td>
              <td className="num tone-good">{fmtCost(s.cost)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

// Build per-MCP-server rows by enriching /api/tool-costs.mcp_servers with
// distinct-tool counts and aggregate result_tokens from .tools[].
const buildMcpRows = () => {
  const servers = (D.toolCosts && D.toolCosts.mcp_servers) || [];
  const tools = (D.toolCosts && D.toolCosts.tools) || [];
  const byServer = new Map();
  for (const t of tools) {
    if (!t.mcp_server) continue;
    const e = byServer.get(t.mcp_server) || { tools: 0, tokens: 0, errors: 0 };
    e.tools += 1;
    e.tokens += t.result_tokens || 0;
    e.errors += t.errors || 0;
    byServer.set(t.mcp_server, e);
  }
  return servers.map((s) => {
    const extras = byServer.get(s.server) || { tools: 0, tokens: 0, errors: 0 };
    return {
      name: s.server,
      slug: s.server,
      tools: extras.tools,
      calls: s.calls || 0,
      errors: extras.errors,
      tokens: extras.tokens,
      cost: s.attributed_cost_usd || 0,
    };
  });
};

const buildCacheRows = () => {
  const days = (D.cacheStats && D.cacheStats.days) || [];
  return days.map((d) => ({
    name: d.date,
    slug: d.date,
    hit: d.hit_rate || 0,
    churn: d.churn_rate || 0,
    input: d.input || 0,
    cacheRead: d.cache_read || 0,
    cacheCreate: (d.cache_create_5m || 0) + (d.cache_create_1h || 0),
    cost: 0, // satisfies the shared total/max math without affecting display
  }));
};

const CacheTable = ({ rows }) => {
  const { sorted, sortState, requestSort } = useSortable(rows, "name", "desc", {
    name: (r) => r.name,
    hit: (r) => r.hit || 0,
    churn: (r) => r.churn || 0,
    input: (r) => r.input || 0,
    cacheRead: (r) => r.cacheRead || 0,
    cacheCreate: (r) => r.cacheCreate || 0,
  });
  const headProps = { state: sortState, requestSort };
  const maxRead = Math.max(1, ...rows.map((r) => r.cacheRead || 0));
  return (
    <div className="a-table-scroll">
      <table className="a-table a-sink-table">
        <thead><tr>
          <SortHeader sortKey="name" {...headProps}>date</SortHeader>
          <SortHeader sortKey="hit" className="num" {...headProps}>hit %</SortHeader>
          <SortHeader sortKey="churn" className="num" {...headProps}>churn %</SortHeader>
          <SortHeader sortKey="input" className="num" {...headProps}>fresh input</SortHeader>
          <SortHeader sortKey="cacheRead" className="num" {...headProps}>cache reads</SortHeader>
          <SortHeader sortKey="cacheCreate" className="num" {...headProps}>cache writes</SortHeader>
        </tr></thead>
        <tbody>
          {sorted.map((r) => {
            const hitTone = r.hit >= 0.9 ? "tone-good" : r.hit >= 0.7 ? "tone-warn" : "tone-bad";
            return (
              <tr key={r.slug} className="has-bar" style={pctStyle(r.cacheRead, maxRead)}>
                <td className="mono">{r.name}</td>
                <td className={`num ${hitTone}`}>{(r.hit * 100).toFixed(1)}%</td>
                <td className="num">{(r.churn * 100).toFixed(1)}%</td>
                <td className="num muted">{fmtTokens(r.input)}</td>
                <td className="num">{fmtTokens(r.cacheRead)}</td>
                <td className="num muted">{fmtTokens(r.cacheCreate)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};

const McpTable = ({ rows, max }) => {
  const { sorted, sortState, requestSort } = useSortable(rows, "cost", "desc", {
    name: (r) => r.name,
    tools: (r) => r.tools || 0,
    calls: (r) => r.calls || 0,
    errors: (r) => r.errors || 0,
    tokens: (r) => r.tokens || 0,
    cost: (r) => r.cost || 0,
  });
  const headProps = { state: sortState, requestSort };
  return (
    <div className="a-table-scroll">
      <table className="a-table a-sink-table">
        <thead><tr>
          <SortHeader sortKey="name" {...headProps}>mcp server</SortHeader>
          <SortHeader sortKey="tools" className="num" {...headProps}>tools</SortHeader>
          <SortHeader sortKey="calls" className="num" {...headProps}>calls</SortHeader>
          <SortHeader sortKey="errors" className="num" {...headProps}>errors</SortHeader>
          <SortHeader sortKey="tokens" className="num" {...headProps}>tokens</SortHeader>
          <SortHeader sortKey="cost" className="num" {...headProps}>cost</SortHeader>
        </tr></thead>
        <tbody>
          {sorted.map((s) => (
            <tr key={s.slug} className="has-bar" style={pctStyle(s.cost, max)}>
              <td>
                <div className="a-proj-nick">{s.name}</div>
              </td>
              <td className="num">{s.tools}</td>
              <td className="num">{s.calls}</td>
              <td className={`num ${s.errors > 0 ? "tone-bad" : "muted"}`}>{s.errors}</td>
              <td className="num">{fmtTokens(s.tokens)}</td>
              <td className="num tone-good">{fmtCost(s.cost)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

export const Work = () => {
  const [view, setView] = useState("projects");
  const mcpRows = view === "mcp" ? buildMcpRows() : [];
  const cacheRows = view === "cache" ? buildCacheRows() : [];
  const source = view === "projects" ? (D.projects || [])
    : view === "skills" ? (D.skills || [])
    : view === "mcp" ? mcpRows
    : view === "cache" ? cacheRows
    : (D.topSessions || []);
  const rows = source;
  const max = Math.max(1, ...rows.map((r) => r.cost || 0));
  const total = rows.reduce((a, b) => a + (b.cost || 0), 0);
  const totalLabel = view === "skills" && total > 0 ? `~${fmtCost(total)}` : fmtCost(total);
  const totalSuffix = view === "projects" ? "all-time"
    : view === "skills" ? "est. attributed"
    : view === "mcp" ? "attributed · 30d"
    : view === "cache" ? "days · per-day token mix"
    : "top by cost";
  return (
    <div className="a-route">
      <section className="a-card">
        <div className="a-card-head">
          <div style={{ display: "flex", alignItems: "baseline", gap: 16 }}>
            <h2>Token sink</h2>
            <div className="a-range" style={{ marginLeft: 4 }}>
              <button className={`a-range-tab ${view === "projects" ? "is-active" : ""}`} onClick={() => setView("projects")}>projects</button>
              <button className={`a-range-tab ${view === "skills" ? "is-active" : ""}`} onClick={() => setView("skills")}>skills</button>
              <button className={`a-range-tab ${view === "mcp" ? "is-active" : ""}`} onClick={() => setView("mcp")}>mcp</button>
              <button className={`a-range-tab ${view === "cache" ? "is-active" : ""}`} onClick={() => setView("cache")}>cache</button>
              <button className={`a-range-tab ${view === "sessions" ? "is-active" : ""}`} onClick={() => setView("sessions")}>sessions</button>
            </div>
          </div>
          <span className="a-card-meta">{rows.length} {view} · {totalLabel} {totalSuffix}</span>
        </div>
        {view === "skills" && (
          <div className="a-card-note muted" style={{ padding: "0 16px 8px", fontSize: 12 }}>
            Estimate. Skill bodies load via system-reminder and aren't directly observable; tokens = invocations × definition size, cost prices the first load per session at Sonnet cache-write and subsequent loads at cache-read. Project-local and subagent-dispatched skills show <span className="mono">—</span> when the definition isn't on disk.
          </div>
        )}
        {view === "mcp" && (
          <div className="a-card-note muted" style={{ padding: "0 16px 8px", fontSize: 12 }}>
            MCP cost is attributed per call: parent assistant turn's output cost split evenly across siblings, plus result tokens priced at the same model's input rate. Tools = distinct tool names seen from this server in the last 30 days.
          </div>
        )}
        {view === "projects"
          ? <ProjectsTable rows={rows} max={max} />
          : view === "skills"
          ? <SkillsTable rows={rows} />
          : view === "mcp"
          ? <McpTable rows={rows} max={max} />
          : view === "cache"
          ? <CacheTable rows={rows} />
          : <SessionsTable rows={rows} max={max} />}
      </section>
    </div>
  );
};
