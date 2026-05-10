import React, { useEffect, useState } from "react";
import { Toggle } from "./atoms.jsx";
import { SortHeader, useSortable } from "../../components/sortable.jsx";

const formatBytes = (n) => {
  if (n == null) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
};

export const SourcesCard = () => {
  const [sources, setSources] = useState([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const reload = async () => {
    try {
      const r = await fetch("/api/sources", { cache: "no-store" });
      if (!r.ok) {
        setSources([]);
        setLoaded(true);
        return;
      }
      const d = await r.json();
      setSources(Array.isArray(d) ? d : []);
    } catch (e) {
      setSources([]);
    } finally {
      setLoaded(true);
    }
  };
  useEffect(() => {
    reload();
    const onFocus = () => reload();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);
  const onPick = async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    setBusy(true);
    setStatus({ kind: "info", text: `attaching ${file.name}…` });
    try {
      const r = await fetch("/api/sources/add", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-sqlite3",
          "X-Source-Filename": file.name,
        },
        body: file,
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setStatus({ kind: "bad", text: `failed: ${d.error || r.statusText}` });
      } else {
        setStatus({ kind: "good", text: `attached as ${d.name}` });
        await reload();
        if (window.RELOAD_DATA) window.RELOAD_DATA();
      }
    } catch (err) {
      setStatus({ kind: "bad", text: `failed: ${err.message || err}` });
    }
    setBusy(false);
  };
  const onToggle = async (name, enabled) => {
    setSources((rows) => rows.map((r) => (r.name === name ? { ...r, enabled } : r)));
    try {
      await fetch(`/api/sources/${encodeURIComponent(name)}/toggle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      if (window.RELOAD_DATA) window.RELOAD_DATA();
    } catch (_) {
      reload();
    }
  };
  const onDelete = async (name) => {
    if (!window.confirm(`Remove source "${name}"? The .db file will be deleted from disk.`)) return;
    try {
      await fetch(`/api/sources/${encodeURIComponent(name)}/delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      await reload();
      if (window.RELOAD_DATA) window.RELOAD_DATA();
    } catch (_) {}
  };
  return (
    <section className="a-card">
      <div className="a-card-head">
        <h2>Attached sources</h2>
        <span className="a-card-meta">
          {loaded ? `${sources.length} attached · unioned into reads when enabled` : "loading…"}
        </span>
      </div>
      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <label className={`a-pill-btn ${busy ? "is-busy" : ""}`} style={{ cursor: busy ? "wait" : "pointer" }}>
          <span style={{ marginRight: 6 }}>+</span>{busy ? "attaching…" : "attach DB file"}
          <input
            type="file"
            accept=".db,application/x-sqlite3"
            onChange={onPick}
            disabled={busy}
            style={{ display: "none" }}
          />
        </label>
        <span className="a-card-meta" style={{ flex: 1, minWidth: 200 }}>
          Unlike "import DB" (which merges into the local DB), attached sources stay as separate files. Toggle each one to include or exclude its data from every dashboard query. Best for unioning DBs from <em>different</em> machines — re-attaching your own export will double totals.
        </span>
      </div>
      {status && (
        <div
          className={`a-card-meta ${status.kind === "bad" ? "tone-bad" : status.kind === "good" ? "tone-good" : ""}`}
          style={{ marginTop: 8 }}
        >
          {status.text}
        </div>
      )}
      {sources.length > 0 && (
        <SourcesTable sources={sources} onToggle={onToggle} onDelete={onDelete} />
      )}
    </section>
  );
};

const SourcesTable = ({ sources, onToggle, onDelete }) => {
  const { sorted, sortState, requestSort } = useSortable(sources, null, "desc", {
    name: (r) => r.name,
    size: (r) => r.size_bytes || 0,
    added: (r) => r.added_at || 0,
    enabled: (r) => (r.enabled ? 1 : 0),
  });
  const headProps = { state: sortState, requestSort };
  return (
        <div className="a-table-scroll" style={{ marginTop: 12 }}>
          <table className="a-table">
            <thead>
              <tr>
                <SortHeader sortKey="name" {...headProps}>Source</SortHeader>
                <SortHeader sortKey="size" className="num" {...headProps}>Size</SortHeader>
                <SortHeader sortKey="added" {...headProps}>Added</SortHeader>
                <SortHeader sortKey="enabled" {...headProps}>Enabled</SortHeader>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((s) => (
                <tr key={s.name}>
                  <td>
                    <span className="mono">{s.name}</span>
                    {!s.exists && <span className="a-card-meta tone-bad" style={{ marginLeft: 8 }}>file missing</span>}
                  </td>
                  <td className="num">{formatBytes(s.size_bytes)}</td>
                  <td className="a-card-meta">
                    {s.added_at ? new Date(s.added_at * 1000).toLocaleString() : "—"}
                  </td>
                  <td>
                    <Toggle
                      checked={s.enabled}
                      onChange={(v) => onToggle(s.name, v)}
                      ariaLabel={`enable ${s.name}`}
                    />
                  </td>
                  <td>
                    <button className="a-pill-btn" onClick={() => onDelete(s.name)}>remove</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
  );
};
