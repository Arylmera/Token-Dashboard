import React, { useEffect, useState } from "react";

export const DeveloperCard = () => {
  if (!window.td || typeof window.td.toggleDevTools !== "function") return null;
  return (
    <section className="a-card">
      <div className="a-card-head"><h2>Developer</h2><span className="a-card-meta">renderer debugging</span></div>
      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <button
          className="a-pill-btn"
          onClick={() => { try { window.td.toggleDevTools(); } catch (_) {} }}
        >
          <span style={{ marginRight: 6 }}>{`{}`}</span>open devtools
        </button>
        <span className="a-card-meta">opens a detached Chromium DevTools window</span>
      </div>
    </section>
  );
};

export const AboutCard = () => {
  const [version, setVersion] = useState("");
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/health")
      .then((r) => r.json())
      .then((d) => { if (!cancelled && d && d.version) setVersion(String(d.version)); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, []);
  return (
    <section className="a-card">
      <div className="a-card-head">
        <h2>About</h2>
        <span className="a-card-meta">{loaded ? "build info" : "loading…"}</span>
      </div>
      <dl className="a-glossary">
        <dt>App</dt>
        <dd>token-dashboard</dd>
        <dt>Version</dt>
        <dd className="mono">{version ? `v${version}` : "—"}</dd>
      </dl>
    </section>
  );
};

export const Glossary = () => (
  <section className="a-card">
    <div className="a-card-head"><h2>Glossary</h2></div>
    <dl className="a-glossary">
      <dt>input tokens</dt>
      <dd>What you sent to the model — your prompt plus the conversation history. Billed at the lowest rate.</dd>
      <dt>output tokens</dt>
      <dd>What the model generated. Billed at roughly 5x the input rate.</dd>
      <dt>cache read</dt>
      <dd>Repeated input the API already has cached. Billed at 1/10th the input rate. Big <code>CLAUDE.md</code> files become almost free on repeat.</dd>
      <dt>cache write</dt>
      <dd>The first time a chunk of context is sent, it's cached for 5 minutes. Billed at 1.25x input.</dd>
    </dl>
  </section>
);
