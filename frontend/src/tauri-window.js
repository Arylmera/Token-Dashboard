// Shared accessor for the Tauri v2 current-window handle. Returns null in a
// plain browser (no __TAURI__) so callers can no-op cleanly.
export const getTauriWindow = () => {
  const t = typeof window !== "undefined" ? window.__TAURI__ : null;
  if (!t || !t.window) return null;
  try { return t.window.getCurrentWindow ? t.window.getCurrentWindow() : null; }
  catch { return null; }
};
