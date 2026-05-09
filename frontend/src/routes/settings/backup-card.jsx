import React, { useState } from "react";

export const BackupCard = () => {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState(null);
  const onPick = async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";  // allow re-picking the same file
    if (!file) return;
    setBusy(true);
    setStatus({ kind: "info", text: `merging ${file.name}…` });
    try {
      const r = await fetch("/api/import.db", {
        method: "POST",
        headers: { "Content-Type": "application/x-sqlite3" },
        body: file,
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setStatus({ kind: "bad", text: `failed: ${d.error || r.statusText}` });
      } else {
        setStatus({
          kind: "good",
          text: `merged · +${d.messages_added} messages · +${d.tags_added} tags`,
        });
        if (window.RELOAD_DATA) window.RELOAD_DATA();
      }
    } catch (err) {
      setStatus({ kind: "bad", text: `failed: ${err.message || err}` });
    }
    setBusy(false);
  };
  return (
    <section className="a-card">
      <div className="a-card-head">
        <h2>Backup &amp; portability</h2>
        <span className="a-card-meta">SQLite snapshot · safe during scans</span>
      </div>
      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <a className="a-pill-btn" href="/api/export.db" download>
          <span style={{ marginRight: 6 }}>↓</span>export DB
        </a>
        <label className={`a-pill-btn ${busy ? "is-busy" : ""}`} style={{ cursor: busy ? "wait" : "pointer" }}>
          <span style={{ marginRight: 6 }}>↑</span>{busy ? "importing…" : "import DB"}
          <input
            type="file"
            accept=".db,application/x-sqlite3"
            onChange={onPick}
            disabled={busy}
            style={{ display: "none" }}
          />
        </label>
        <span className="a-card-meta" style={{ flex: 1, minWidth: 200 }}>
          Export downloads a consistent copy of <code>~/.claude/token-dashboard.db</code>. Import merges another machine's export by <code>(session_id, message_id)</code> — same project on two machines may show under two slugs until project mapping lands.
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
    </section>
  );
};
