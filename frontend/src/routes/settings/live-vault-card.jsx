import React, { useState } from "react";
import { vaultPathStore, setVaultPath, initVaultPath } from "../../live/stores/vault-store.js";
import { useStore } from "../../live/stores/use-store.js";

const isTauri =
  typeof window !== "undefined" &&
  ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);

export const LiveVaultCard = () => {
  const vaultPath = useStore(vaultPathStore);
  const [busy, setBusy] = useState(false);

  const onChoose = async () => {
    if (!isTauri || busy) return;
    setBusy(true);
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({ directory: true, multiple: false });
      if (typeof selected === "string" && selected) setVaultPath(selected);
    } catch (_) {
      /* dialog cancelled or unavailable — keep current vault */
    }
    setBusy(false);
  };

  const onReset = () => {
    setVaultPath("");
    initVaultPath();
  };

  return (
    <section className="a-card">
      <div className="a-card-head">
        <h2>Live Explorer vault</h2>
        <span className="a-card-meta">folder the Live → Explorer tab browses</span>
      </div>
      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <button
          type="button"
          className={`a-pill-btn ${busy ? "is-busy" : ""}`}
          style={{ cursor: !isTauri ? "default" : busy ? "wait" : "pointer" }}
          onClick={onChoose}
          disabled={!isTauri || busy}
          title={!isTauri ? "Folder picker is only available in the desktop app" : undefined}
        >
          <span style={{ marginRight: 6 }}>📁</span>{busy ? "choosing…" : "Choose folder…"}
        </button>
        <button
          type="button"
          className="a-pill-btn"
          style={{ cursor: "pointer" }}
          onClick={onReset}
        >
          <span style={{ marginRight: 6 }}>↺</span>Reset to default
        </button>
        <span className="a-card-meta" style={{ flex: 1, minWidth: 200 }}>
          The markdown / notes vault the Live → Explorer tab browses. Defaults to your
          Claude projects dir (<code>~/.claude/projects</code>).
        </span>
      </div>
      <div className="a-card-meta" style={{ marginTop: 8 }}>
        {vaultPath
          ? <>Current vault: <code>{vaultPath}</code></>
          : <>Auto: <code>~/.claude/projects</code></>}
      </div>
    </section>
  );
};
