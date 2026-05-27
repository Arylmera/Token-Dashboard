import React, { useEffect, useState } from "react";
import { NAV_ITEMS } from "../nav-items.js";
import { getThemedCopy } from "../themed-copy.js";
import { tabVisible } from "../levels.js";

const PIN_KEY = "td:rail-pinned";
const readPinned = () => { try { return localStorage.getItem(PIN_KEY) === "1"; } catch { return false; } };
const writePinned = (v) => { try { localStorage.setItem(PIN_KEY, v ? "1" : "0"); } catch {} };

export const NavRail = ({ tab, setTab, level = 1, themeId }) => {
  const tc = getThemedCopy(themeId);
  const [pinned, setPinned] = useState(readPinned);
  const [hovering, setHovering] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const expanded = pinned || hovering;
  const items = NAV_ITEMS.filter((it) => tabVisible(level, it.id));

  const onPin = () => { const v = !pinned; setPinned(v); writePinned(v); };
  const pick = (id) => { setTab(id); setDrawerOpen(false); };

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
        <div className="a-rail-head" data-tauri-drag-region>
          <span className="a-rail-dot" aria-hidden="true" />
          <button className={`a-rail-pin ${pinned ? "is-pinned" : ""}`} data-tauri-drag-region="false"
                  aria-pressed={pinned} aria-label={pinned ? "Unpin sidebar" : "Pin sidebar"} onClick={onPin}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4">
              <path d="M5 1h4l-.5 4 2 2v1H3.5V7l2-2L5 1zM7 8v5"/>
            </svg>
          </button>
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
