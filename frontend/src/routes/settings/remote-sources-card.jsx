import React, { useEffect, useState } from "react";

const fmtAgo = (ts) => {
  if (!ts) return "never";
  const ms = Date.now() - ts * 1000;
  if (ms < 60_000) return "just now";
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
};

const SECRET_PLACEHOLDER = "set on host via TOKEN_DASHBOARD_SYNC_TOKEN";

/**
 * Manage remote-machine read-only sync sources. The host shares its DB via
 * /api/sync/snapshot (gated by Bearer auth from the env var); this card
 * is the viewer-side: add hosts, trigger manual pulls, see last status.
 */
export const RemoteSourcesCard = () => {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [draft, setDraft] = useState({ label: "", base_url: "", bearer: "" });
  const [busyId, setBusyId] = useState(null);

  const load = () => {
    fetch("/api/remote-sources")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`status ${r.status}`))))
      .then(setRows)
      .catch((e) => {
        setError(e.message || "fetch failed");
        setRows([]);
      });
  };

  useEffect(() => {
    load();
  }, []);

  const add = async (e) => {
    e.preventDefault();
    if (!draft.label.trim() || !draft.base_url.trim()) return;
    const r = await fetch("/api/remote-sources", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        label: draft.label.trim(),
        base_url: draft.base_url.trim(),
        bearer: draft.bearer || null,
      }),
    });
    if (r.ok) {
      setDraft({ label: "", base_url: "", bearer: "" });
      load();
    } else {
      const body = await r.json().catch(() => ({}));
      alert(`Add failed: ${body.error || r.statusText}`);
    }
  };

  const sync = async (id) => {
    setBusyId(id);
    try {
      const r = await fetch(`/api/remote-sources/${id}/sync`, { method: "POST" });
      if (r.ok) {
        const stats = await r.json();
        alert(`Synced ${stats.messages_inserted} messages, ${stats.tool_calls_inserted} tool calls`);
      } else {
        const body = await r.json().catch(() => ({}));
        alert(`Sync failed: ${body.error || r.statusText}`);
      }
    } finally {
      setBusyId(null);
      load();
    }
  };

  const toggle = async (id, next) => {
    await fetch(`/api/remote-sources/${id}/toggle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: next }),
    });
    load();
  };

  const remove = async (id) => {
    if (!confirm("Remove this remote source?")) return;
    await fetch(`/api/remote-sources/${id}`, { method: "DELETE" });
    load();
  };

  return (
    <section className="a-card">
      <div className="a-card-head">
        <h2>Remote machines</h2>
        <span className="a-card-meta">
          read-only sync · this machine pulls from each host below
        </span>
      </div>
      <div className="a-hint" style={{ padding: "0 16px 8px" }}>
        Host side: another Token Dashboard install must export{" "}
        <code>TOKEN_DASHBOARD_SYNC_TOKEN</code> before launching; that's the
        bearer the viewer machines must send back.
      </div>
      <form onSubmit={add} className="a-remote-add">
        <input
          type="text"
          placeholder="label (e.g. laptop)"
          value={draft.label}
          onChange={(e) => setDraft((d) => ({ ...d, label: e.target.value }))}
        />
        <input
          type="url"
          placeholder="http://other-machine:8080"
          value={draft.base_url}
          onChange={(e) => setDraft((d) => ({ ...d, base_url: e.target.value }))}
        />
        <input
          type="password"
          placeholder="bearer token"
          value={draft.bearer}
          onChange={(e) => setDraft((d) => ({ ...d, bearer: e.target.value }))}
          title={SECRET_PLACEHOLDER}
        />
        <button type="submit" className="a-page-btn">Add</button>
      </form>
      {error && <div className="a-hint" style={{ padding: "0 16px 8px" }}>Failed to load: {error}</div>}
      {rows && rows.length === 0 && (
        <div className="a-hint" style={{ padding: "0 16px 12px" }}>No remote machines configured.</div>
      )}
      {rows && rows.length > 0 && (
        <table className="a-table">
          <thead>
            <tr>
              <th>label</th>
              <th>url</th>
              <th>last sync</th>
              <th>status</th>
              <th>actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className={r.enabled ? "" : "muted"}>
                <td>{r.label}</td>
                <td className="mono">{r.base_url}</td>
                <td className="muted">{fmtAgo(r.last_sync_at)}</td>
                <td className={r.last_error ? "tone-bad" : ""}>
                  {r.last_error
                    ? r.last_error.slice(0, 40)
                    : r.last_sync_at
                      ? "ok"
                      : "—"}
                </td>
                <td>
                  <button
                    type="button"
                    className="a-page-btn"
                    disabled={busyId === r.id || !r.enabled}
                    onClick={() => sync(r.id)}
                  >
                    {busyId === r.id ? "syncing…" : "sync"}
                  </button>
                  <button
                    type="button"
                    className="a-page-btn"
                    onClick={() => toggle(r.id, !r.enabled)}
                    style={{ marginLeft: 4 }}
                  >
                    {r.enabled ? "disable" : "enable"}
                  </button>
                  <button
                    type="button"
                    className="a-page-btn"
                    onClick={() => remove(r.id)}
                    style={{ marginLeft: 4 }}
                  >
                    delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
};
