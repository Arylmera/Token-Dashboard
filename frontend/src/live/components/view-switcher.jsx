import React from "react";
import { themedCopy } from "../themes/theme";
import { viewStore, setView } from "../stores/view-store.js";
import { useStore } from "../stores/use-store.js";

// View type (was: "console" | "cockpit" | "explorer" | "settings")
const VIEWS = ["console", "cockpit", "explorer", "settings"];

export function ViewSwitcher() {
  const view = useStore(viewStore);
  return (
    <nav className="pr-nav">
      {VIEWS.map((v) => (
        <button
          key={v}
          className={`pr-navlink${view === v ? " is-active" : ""}`}
          onClick={() => setView(v)}
        >
          {themedCopy()?.nav[v] ?? v}
        </button>
      ))}
    </nav>
  );
}
