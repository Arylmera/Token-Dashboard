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
    <div className="pr-explorer">
      <div className="pr-subnav">
        {SUBS.map((s) => (
          <button
            key={s}
            className={sub === s ? "is-active" : ""}
            onClick={() => setSub(s)}
          >
            {s}
          </button>
        ))}
      </div>
      <div className="pr-explorer-pane">
        {sub === "files" && <Files />}
        {sub === "map" && <MapView />}
        {sub === "sessions" && <Sessions />}
      </div>
    </div>
  );
}
