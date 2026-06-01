import React from "react";
import { subStore, setSub } from "../stores/explorer-store.js";
import { useStore } from "../stores/use-store.js";
import { Files } from "./explorer/files.jsx";
import { MapView } from "./explorer/map.jsx";
import { Sessions } from "./explorer/sessions.jsx";

const SUBS = ["files", "map", "sessions"];

export function Explorer() {
  const sub = useStore(subStore);
  return (
    <div className="a-explorer">
      <div className="a-pill-btn-row" role="tablist" style={{ marginBottom: "12px" }}>
        {SUBS.map((s) => (
          <button
            key={s}
            className={["a-pill-btn", sub === s && "is-active"].filter(Boolean).join(" ")}
            role="tab"
            aria-selected={sub === s}
            onClick={() => setSub(s)}
          >
            {s}
          </button>
        ))}
      </div>
      <div className="a-explorer-pane">
        {sub === "files" && <Files />}
        {sub === "map" && <MapView />}
        {sub === "sessions" && <Sessions />}
      </div>
    </div>
  );
}
