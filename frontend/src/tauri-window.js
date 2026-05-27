// Shared accessor for the Tauri v2 current-window handle. Returns null in a
// plain browser (no __TAURI__) so callers can no-op cleanly.
export const getTauriWindow = () => {
  const t = typeof window !== "undefined" ? window.__TAURI__ : null;
  if (!t || !t.window) return null;
  try { return t.window.getCurrentWindow ? t.window.getCurrentWindow() : null; }
  catch { return null; }
};

export const RESIZE_EDGES = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];

const DIRECTION = {
  n: "North", s: "South", e: "East", w: "West",
  ne: "NorthEast", nw: "NorthWest", se: "SouthEast", sw: "SouthWest",
};

// Maps an edge key to the Tauri v2 ResizeDirection string consumed by
// `appWindow.startResizeDragging(direction)`. Returns null for unknown keys.
export const resizeDirectionFor = (edge) => DIRECTION[edge] ?? null;
