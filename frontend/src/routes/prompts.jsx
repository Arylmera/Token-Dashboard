import React, { useEffect, useRef, useState } from "react";
import { D } from "../data-store.js";
import { fmtCost, fmtTokens } from "../format.js";
import { Label, ModelBadge } from "../components/atoms.jsx";
import { SortHeader, useSortable } from "../components/sortable.jsx";

// /api/verbosity returns prompts where input chars vastly exceed output tokens
// — the long-prompt-tiny-reply pattern. Mixed units (chars vs tokens) is the
// price of not shipping a tokenizer in the frontend; ranking stays stable.
const VerbosityList = () => {
  const [rows, setRows] = useState([]);
  const [minChars, setMinChars] = useState(200);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    fetch(`/api/verbosity?min_chars=${minChars}&top=50`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data) => { if (!cancelled) { setRows(Array.isArray(data) ? data : []); setLoading(false); } })
      .catch((e) => { if (!cancelled) { setErr(String(e)); setLoading(false); } });
    return () => { cancelled = true; };
  }, [minChars]);
  return (
    <section className="a-card">
      <div className="a-card-head">
        <h2>Wasted prompts</h2>
        <span className="a-card-meta">long prompt, tiny reply · ratio = chars in / tokens out</span>
        <label className="a-prompt-search-label">
          min chars
          <input
            type="number"
            min="1"
            max="100000"
            value={minChars}
            onChange={(e) => setMinChars(Math.max(1, +e.target.value || 1))}
            className="a-prompt-search"
            style={{ minWidth: 80, width: 80 }}
          />
        </label>
      </div>
      {loading && <div style={{ padding: 12, color: "var(--gull)" }}>loading…</div>}
      {err && <div style={{ padding: 12, color: "var(--bad)" }}>error: {err}</div>}
      {!loading && !err && rows.length === 0 && (
        <div style={{ padding: 12, color: "var(--gull)" }}>nothing above this threshold</div>
      )}
      {!loading && !err && rows.length > 0 && (
        <table className="a-table">
          <thead>
            <tr>
              <th>when</th>
              <th className="num">chars in</th>
              <th className="num">tokens out</th>
              <th className="num">ratio</th>
              <th>model</th>
              <th>preview</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={`${r.session_id}-${i}`}>
                <td className="num" style={{ whiteSpace: "nowrap" }}>
                  {(r.timestamp || "").slice(0, 16).replace("T", " ")}
                </td>
                <td className="num">{fmtTokens(r.prompt_chars)}</td>
                <td className="num">{fmtTokens(r.output_tokens)}</td>
                <td className="num tone-warn">{r.ratio.toFixed(1)}</td>
                <td><ModelBadge model={r.model} /></td>
                <td style={{ maxWidth: 420, color: "var(--bone)" }}>{r.preview}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
};

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
  const [tab, setTab] = useState("expensive");
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
      <div className="a-pill-btn-row" role="tablist" style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <button
          role="tab"
          aria-selected={tab === "expensive"}
          className={tab === "expensive" ? "a-pill-btn is-active" : "a-pill-btn"}
          onClick={() => setTab("expensive")}
        >
          Expensive
        </button>
        <button
          role="tab"
          aria-selected={tab === "wasted"}
          className={tab === "wasted" ? "a-pill-btn is-active" : "a-pill-btn"}
          onClick={() => setTab("wasted")}
        >
          Wasted
        </button>
      </div>
      {tab === "wasted" && <VerbosityList />}
      {tab === "expensive" && (
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
      )}
    </div>
  );
};
