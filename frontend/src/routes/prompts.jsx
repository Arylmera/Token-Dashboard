import React, { useEffect, useRef, useState } from "react";
import { D } from "../data-store.js";
import { fmtCost, fmtTokens } from "../format.js";
import { Label, ModelBadge } from "../components/atoms.jsx";
import { SortHeader, useSortable } from "../components/sortable.jsx";

// FTS5 query: 250ms debounce so each keystroke doesn't refetch.
const usePromptSearch = () => {
  const [query, setQuery] = useState("");
  const timer = useRef(null);
  useEffect(() => {
    if (!window.SET_PROMPT_QUERY) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      window.SET_PROMPT_QUERY(query);
    }, 250);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [query]);
  // Clear the server-side filter when the route unmounts so other views
  // don't see a stale `q` on their next prompts refetch.
  useEffect(() => () => {
    if (window.SET_PROMPT_QUERY) window.SET_PROMPT_QUERY("");
  }, []);
  return [query, setQuery];
};

export const Prompts = () => {
  const [openId, setOpenId] = useState(null);
  const [query, setQuery] = usePromptSearch();
  const { sorted, sortState, requestSort } = useSortable(D.prompts || [], "tokens", "desc", {
    preview: (r) => r.preview,
    project: (r) => r.project,
    session: (r) => r.session,
    model: (r) => r.model,
    tokens: (r) => r.tokens || 0,
    cost: (r) => r.cost || 0,
    time: (r) => r.time,
  });
  const headProps = { state: sortState, requestSort };
  return (
    <div className="a-route">
      <section className="a-card">
        <div className="a-card-head">
          <h2>Most expensive prompts</h2>
          <span className="a-card-meta">click headers to sort · click row to expand</span>
          <input
            type="search"
            className="a-prompt-search"
            placeholder="search prompts…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search prompts"
          />
        </div>
        <table className="a-table">
          <thead>
            <tr>
              <SortHeader sortKey="preview" {...headProps}>preview</SortHeader>
              <SortHeader sortKey="project" {...headProps}>project</SortHeader>
              <SortHeader sortKey="session" {...headProps}>session</SortHeader>
              <SortHeader sortKey="model" {...headProps}>model</SortHeader>
              <SortHeader sortKey="tokens" className="num" {...headProps}>tokens</SortHeader>
              <SortHeader sortKey="cost" className="num" {...headProps}>cost</SortHeader>
              <SortHeader sortKey="time" className="num" {...headProps}>when</SortHeader>
            </tr>
          </thead>
          <tbody>
            {sorted.map((p) => (
              <React.Fragment key={p.id}>
                <tr className="clickable" onClick={() => setOpenId(openId === p.id ? null : p.id)}>
                  <td style={{ maxWidth: 380, color: "var(--bone)" }}>
                    <span style={{ marginRight: 6, color: "var(--gull)" }}>{openId === p.id ? "▾" : "▸"}</span>
                    {p.preview}
                  </td>
                  <td className="mono">{p.project}</td>
                  <td className="mono">{p.session}</td>
                  <td><ModelBadge model={p.model} /></td>
                  <td className="num">{fmtTokens(p.tokens)}</td>
                  <td className="num tone-good">{fmtCost(p.cost)}</td>
                  <td className="num" style={{ whiteSpace: "nowrap" }}>{p.time}</td>
                </tr>
                {openId === p.id && (
                  <tr className="a-drawer-row">
                    <td colSpan={7}>
                      <div className="a-drawer">
                        <div className="a-drawer-head"><Label>prompt · {fmtTokens(p.tokens)} tokens</Label></div>
                        <pre className="a-pre">{p.preview}</pre>
                      </div>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
};
