import React, { useEffect, useMemo, useState } from "react";
import { fmtCost, fmtTokens } from "../format.js";
import { KPI } from "../components/atoms.jsx";
import { SortHeader, useSortable } from "../components/sortable.jsx";

// Stash a tag intent in sessionStorage so the Sessions route can hydrate
// its tagFilter on mount. Hash-only routing means a `?tag=` query string
// would get clobbered by the hash router; sessionStorage is short-lived
// and survives the navigation cleanly.
const TAG_INTENT_KEY = "td:sessions:tagIntent";

const setTagIntent = (tag) => {
  try {
    window.sessionStorage.setItem(TAG_INTENT_KEY, tag);
  } catch {
    /* private mode — fall through; user will land on Sessions unfiltered. */
  }
};

const useTagsSummary = () => {
  const [rows, setRows] = useState([]);
  const [state, setState] = useState("loading");
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetch("/api/tags-summary", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : []))
        .then((data) => {
          if (cancelled) return;
          setRows(Array.isArray(data) ? data : []);
          setState("ready");
        })
        .catch(() => { if (!cancelled) setState("error"); });
    };
    load();
    // Pick up tag mutations made on the Sessions tab without a full reload.
    const onSse = (e) => {
      const t = e && e.detail && e.detail.type;
      if (t === "tags" || t === "scan_complete") load();
    };
    window.addEventListener("td:sse", onSse);
    return () => {
      cancelled = true;
      window.removeEventListener("td:sse", onSse);
    };
  }, []);
  return { rows, state };
};

const fmtDate = (iso) => (iso ? String(iso).slice(0, 10) : "—");

const Totals = ({ rows }) => {
  const totals = useMemo(() => {
    return rows.reduce(
      (acc, r) => ({
        tags: acc.tags + 1,
        sessions: acc.sessions + (r.sessions || 0),
        tokens: acc.tokens + (r.total_tokens || 0),
        cost: acc.cost + (r.cost_usd || 0),
      }),
      { tags: 0, sessions: 0, tokens: 0, cost: 0 },
    );
  }, [rows]);
  return (
    <div className="a-kpi-row">
      <KPI label="tags" value={totals.tags.toLocaleString()} />
      <KPI label="tagged sessions" value={totals.sessions.toLocaleString()} />
      <KPI label="tokens" value={fmtTokens(totals.tokens)} />
      <KPI label="cost" value={fmtCost(totals.cost)} />
    </div>
  );
};

export const Tags = () => {
  const { rows, state } = useTagsSummary();
  const { sorted, sortState, requestSort } = useSortable(rows, "cost_usd", "desc");

  const openTag = (tag) => {
    setTagIntent(tag);
    window.location.hash = "/sessions";
  };

  return (
    <div className="a-route">
      <section className="a-card" style={{ marginBottom: 12 }}>
        <div className="a-card-head">
          <h2>Cost per tag</h2>
          <span className="a-card-meta">click a tag to open the matching sessions</span>
        </div>
        <Totals rows={rows} />
      </section>
      <section className="a-card">
        {state === "loading" && <div className="muted">Loading…</div>}
        {state === "error" && <div className="muted">Failed to load tag summary.</div>}
        {state === "ready" && rows.length === 0 && (
          <div className="muted">
            No tags yet. Open the Sessions tab and add a tag to any session to
            start tracking cost per feature.
          </div>
        )}
        {state === "ready" && rows.length > 0 && (
          <table className="a-table">
            <thead>
              <tr>
                <SortHeader sortKey="tag" state={sortState} requestSort={requestSort}>tag</SortHeader>
                <SortHeader sortKey="sessions" state={sortState} requestSort={requestSort}>sessions</SortHeader>
                <SortHeader sortKey="total_tokens" state={sortState} requestSort={requestSort}>tokens</SortHeader>
                <SortHeader sortKey="cost_usd" state={sortState} requestSort={requestSort}>cost</SortHeader>
                <SortHeader sortKey="first_seen" state={sortState} requestSort={requestSort}>first</SortHeader>
                <SortHeader sortKey="last_seen" state={sortState} requestSort={requestSort}>last</SortHeader>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => (
                <tr key={r.tag}>
                  <td>
                    <button
                      type="button"
                      className="a-tag-chip a-tag-chip-btn"
                      onClick={() => openTag(r.tag)}
                      title={`Open sessions tagged "${r.tag}"`}
                    >
                      {r.tag}
                    </button>
                  </td>
                  <td>{(r.sessions || 0).toLocaleString()}</td>
                  <td>{fmtTokens(r.total_tokens || 0)}</td>
                  <td>{fmtCost(r.cost_usd || 0)}</td>
                  <td>{fmtDate(r.first_seen)}</td>
                  <td>{fmtDate(r.last_seen)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
};
