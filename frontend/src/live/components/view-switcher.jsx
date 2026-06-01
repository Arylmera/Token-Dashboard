import React, { useState } from "react";
import { viewStore, setView } from "../stores/view-store.js";
import { useStore } from "../stores/use-store.js";

const hasTauri = () =>
  typeof window !== "undefined" &&
  ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);

// Open the Live pop-out window via the backend Tauri command. No-op in plain
// web/dev (no Tauri) so the rail button degrades gracefully.
const openPopout = async () => {
  if (!hasTauri()) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("open_live_window");
  } catch {
    /* ignore — window may already be open */
  }
};

const ico = (...children) =>
  React.createElement(
    "svg",
    { width: 16, height: 16, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round" },
    ...children,
  );
const p = (d) => React.createElement("path", { d });
const r = (a) => React.createElement("rect", a);
const c = (a) => React.createElement("circle", a);

// The three Live views. "settings" is gone — theme/glass/vault live in the
// main dashboard Settings tab.
const VIEWS = [
  { id: "console", label: "console", icon: ico(r({ x: 1.5, y: 2.5, width: 13, height: 11, rx: 1 }), p("M4 6l2 2-2 2M8.5 10.5h3")) },
  { id: "cockpit", label: "cockpit", icon: ico(c({ cx: 8, cy: 8, r: 1.5 }), p("M4.5 4.5a5 5 0 000 7M11.5 4.5a5 5 0 010 7M2.5 2.5a8 8 0 000 11M13.5 2.5a8 8 0 010 11")) },
  { id: "explorer", label: "explorer", icon: ico(p("M1.5 3.5a1 1 0 011-1H6l1.5 1.5h6a1 1 0 011 1v7a1 1 0 01-1 1h-11a1 1 0 01-1-1v-8z"), p("M4.5 7.5h7M6.5 10h5")) },
];

// Box-with-arrow "pop out" glyph.
const POPOUT_ICON = ico(
  p("M9.5 2.5h4v4"),
  p("M13.5 2.5L8 8"),
  p("M11.5 9v3.5a1 1 0 01-1 1h-7a1 1 0 01-1-1v-7a1 1 0 011-1H7"),
);

// Secondary nav rail for the Live tab — a slim icon rail that expands on hover,
// identical in look/behaviour to the main dashboard nav bar (.a-rail). Reuses
// the .a-rail-nav / .a-rail-link / .a-rail-ico / .a-rail-label classes so it is
// pixel-consistent with the main bar.
export function LiveRail() {
  const view = useStore(viewStore);
  const [hovering, setHovering] = useState(false);

  return (
    <aside
      className={`a-live-subrail ${hovering ? "is-expanded" : ""}`}
      aria-label="Live views"
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
    >
      <nav className="a-rail-nav">
        {VIEWS.map((v) => (
          <button
            key={v.id}
            data-view={v.id}
            className={`a-rail-link ${view === v.id ? "is-active" : ""}`}
            title={v.label}
            aria-current={view === v.id ? "page" : undefined}
            onClick={() => setView(v.id)}
          >
            <span className="a-rail-ico" aria-hidden="true">{v.icon}</span>
            <span className="a-rail-label">{v.label}</span>
          </button>
        ))}
      </nav>
      <button
        type="button"
        className="a-rail-link a-rail-popout"
        title="pop out"
        onClick={openPopout}
      >
        <span className="a-rail-ico" aria-hidden="true">{POPOUT_ICON}</span>
        <span className="a-rail-label">pop out</span>
      </button>
    </aside>
  );
}
