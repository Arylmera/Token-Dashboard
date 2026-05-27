import React from "react";
import { RESIZE_EDGES, resizeDirectionFor, getTauriWindow } from "../tauri-window.js";

// Eight invisible grab zones pinned to the window border. Each starts a native
// Tauri resize drag. Renders nothing outside Tauri (browser supplies chrome).
export const WindowResizeHandles = () => {
  const win = getTauriWindow();
  if (!win) return null;
  const start = (edge) => (e) => {
    const dir = resizeDirectionFor(edge);
    if (!dir || e.button !== 0) return;
    e.preventDefault();
    try { win.startResizeDragging(dir); } catch {}
  };
  return (
    <div className="a-resize-layer" aria-hidden="true">
      {RESIZE_EDGES.map((edge) => (
        <div key={edge} className={`a-resize a-resize-${edge}`} onMouseDown={start(edge)} />
      ))}
    </div>
  );
};
