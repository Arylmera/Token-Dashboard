import React, { useEffect, useState } from "react";
import { SettingRow } from "./atoms.jsx";

const DENSITY_KEY = "td.density.v1";
const DENSITY_OPTIONS = [
  { id: "compact",     label: "compact" },
  { id: "comfortable", label: "comfortable" },
  { id: "spacious",    label: "spacious" },
];

const applyDensity = (id) => {
  const root = document.querySelector(".dir-a-root");
  if (!root) return;
  if (id === "comfortable") root.removeAttribute("data-density");
  else root.setAttribute("data-density", id);
};

export const DensityCard = () => {
  const [density, setDensity] = useState(() => {
    try { return localStorage.getItem(DENSITY_KEY) || "comfortable"; }
    catch (_) { return "comfortable"; }
  });
  useEffect(() => {
    applyDensity(density);
    try { localStorage.setItem(DENSITY_KEY, density); } catch (_) {}
  }, [density]);
  return (
    <section className="a-card">
      <div className="a-card-head"><h2>Density</h2><span className="a-card-meta">spacing across cards, KPIs, tables</span></div>
      <div className="a-density" role="radiogroup" aria-label="Density">
        {DENSITY_OPTIONS.map((opt) => (
          <button
            key={opt.id}
            type="button"
            role="radio"
            aria-checked={density === opt.id}
            className={`a-density-btn ${density === opt.id ? "is-on" : ""}`}
            onClick={() => setDensity(opt.id)}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </section>
  );
};

export const AdvancedModeCard = ({ enabled, onChange, loaded, saving }) => (
  <section className="a-card">
    <div className="a-card-head">
      <h2>Advanced mode</h2>
      <span className="a-card-meta">{saving ? "saving…" : (loaded ? "extra tabs and editable internals" : "loading…")}</span>
    </div>
    <SettingRow
      title="Show advanced settings and tabs"
      description="Reveals the API tab, the editable pricing table, and the plan limit estimates. Leave off if you only want overview-level numbers."
      checked={enabled}
      onChange={onChange}
    />
  </section>
);

export const MultiProviderCard = ({ enabled, onChange, loaded, saving }) => (
  <section className="a-card">
    <div className="a-card-head">
      <h2>Multi-provider filter</h2>
      <span className="a-card-meta">{saving ? "saving…" : (loaded ? "preview — limited data" : "loading…")}</span>
    </div>
    <SettingRow
      title="Show provider selector in topbar"
      description="Adds an ALL / Claude / Codex switch next to the range tabs. Off by default — current data only contains Claude transcripts, so Codex returns empty until v4.2 lands the ingest path."
      checked={enabled}
      onChange={onChange}
    />
  </section>
);

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
        <dt>Repository</dt>
        <dd>
          <a
            className="a-link is-mono"
            href="https://github.com/Arylmera/Token-Dashboard"
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => {
              const url = "https://github.com/Arylmera/Token-Dashboard";
              const tauri = typeof window !== "undefined" ? window.__TAURI__ : null;
              const invoke = tauri && tauri.core && tauri.core.invoke;
              if (invoke) {
                e.preventDefault();
                invoke("open_external", { url }).catch(() => {});
              }
            }}
          >
            github.com/Arylmera/Token-Dashboard
            <span className="a-link-icon" aria-hidden="true">↗</span>
          </a>
        </dd>
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
