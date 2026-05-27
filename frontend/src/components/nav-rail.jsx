import React, { useEffect, useState } from "react";
import { NAV_ITEMS } from "../nav-items.js";
import { getThemedCopy } from "../themed-copy.js";
import { tabVisible } from "../levels.js";
import { getTauriWindow } from "../tauri-window.js";

// Three rail modes the head button cycles through:
//   hover  — collapsed, expands while the pointer is over the rail
//   open   — fixed expanded
//   closed — fixed collapsed (ignores hover)
const MODE_KEY = "td:rail-mode";
const MODES = ["hover", "open", "closed"];
const MODE_LABEL = { hover: "Open on hover", open: "Pinned open", closed: "Pinned closed" };
const readMode = () => { try { const m = localStorage.getItem(MODE_KEY); return MODES.includes(m) ? m : "hover"; } catch { return "hover"; } };
const writeMode = (m) => { try { localStorage.setItem(MODE_KEY, m); } catch {} };

const stroke = { fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round" };
const modeIcon = (m) =>
  React.createElement("svg", { width: 14, height: 14, viewBox: "0 0 16 16", ...stroke },
    m === "hover"  ? React.createElement("path", { d: "M3 3l8 3.4-3.3 1.3L6.4 13z" })
    : m === "open" ? React.createElement("path", { d: "M3 4l4 4-4 4M9 4l4 4-4 4" })
    :                React.createElement("path", { d: "M7 4L3 8l4 4M13 4l-4 4 4 4" }));

export const NavRail = ({ tab, setTab, level = 1, themeId }) => {
  const tc = getThemedCopy(themeId);
  const [mode, setMode] = useState(readMode);
  const [hovering, setHovering] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const expanded = mode === "open" || (mode === "hover" && hovering);
  const items = NAV_ITEMS.filter((it) => tabVisible(level, it.id));

  const win = getTauriWindow();
  const selectMode = (m) => { setMode(m); writeMode(m); };
  const toggleOpenClosed = () => selectMode(expanded ? "closed" : "open");
  const pick = (id) => { setTab(id); setDrawerOpen(false); };
  const startWindowDrag = (e) => {
    if (e.button !== 0 || !win) return;
    if (e.target.closest("button")) return;
    win.startDragging();
  };

  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e) => { if (e.key === "Escape") setDrawerOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawerOpen]);

  const NavList = ({ inDrawer }) => (
    <nav className="a-rail-nav" aria-label="Primary">
      {items.map((it) => {
        const label = tc?.nav?.[it.id] ?? it.label;
        return (
          <button
            key={it.id}
            data-tab={it.id}
            className={`a-rail-link ${tab === it.id ? "is-active" : ""}`}
            title={(!expanded && !inDrawer) ? label : undefined}
            aria-current={tab === it.id ? "page" : undefined}
            onClick={() => pick(it.id)}
          >
            <span className="a-rail-ico" aria-hidden="true">{it.icon}</span>
            <span className="a-rail-label">{label}</span>
          </button>
        );
      })}
    </nav>
  );

  return (
    <>
      <button
        className="a-rail-burger"
        aria-label="Open navigation"
        aria-expanded={drawerOpen}
        onClick={() => setDrawerOpen(true)}
      >
        <svg width="18" height="18" viewBox="0 0 18 18"><path d="M2 5h14M2 9h14M2 13h14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
      </button>

      <aside
        className={`a-rail ${expanded ? "is-expanded" : ""}`}
        onMouseEnter={() => setHovering(true)}
        onMouseLeave={() => setHovering(false)}
      >
        <div className="a-rail-head" data-tauri-drag-region onMouseDown={startWindowDrag}>
          <button className="a-rail-pin" data-tauri-drag-region="false"
                  aria-label={expanded ? "Collapse sidebar" : "Open sidebar"} title={expanded ? "Collapse" : "Open"} onClick={toggleOpenClosed}>
            <svg width="16" height="16" viewBox="0 0 18 18"><path d="M2 5h14M2 9h14M2 13h14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
          </button>
          <div className="a-rail-modes" role="group" aria-label="Sidebar behaviour" data-tauri-drag-region="false">
            {MODES.map((m) => (
              <button key={m} className={`a-rail-modebtn ${mode === m ? "is-active" : ""}`}
                      aria-pressed={mode === m} title={MODE_LABEL[m]} onClick={() => selectMode(m)}>
                {modeIcon(m)}
              </button>
            ))}
          </div>
        </div>
        <NavList inDrawer={false} />
      </aside>

      {drawerOpen && (
        <div className="a-rail-scrim" onClick={() => setDrawerOpen(false)}>
          <aside className="a-rail-drawer is-expanded" onClick={(e) => e.stopPropagation()}>
            <NavList inDrawer={true} />
          </aside>
        </div>
      )}
    </>
  );
};
