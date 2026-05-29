import { createStore } from "./create-store.js";

const MOTION_KEY = "praetorium.reduceMotion";
export const reduceMotionStore = createStore(localStorage.getItem(MOTION_KEY) === "1");
export function setReduceMotion(v) {
  localStorage.setItem(MOTION_KEY, v ? "1" : "0");
  reduceMotionStore.set(v);
}
export function applyReduceMotion() {
  document.documentElement.setAttribute("data-reduce-motion", reduceMotionStore.get() ? "1" : "0");
}

const GLASS_KEY = "praetorium.glass";
export const glassStore = createStore(localStorage.getItem(GLASS_KEY) === "1");
// Drive native window vibrancy (Mica/Acrylic on Windows, NSVisualEffect on
// macOS) so the OS blur sits behind the CSS .is-glass panels. No-op outside Tauri.
function syncNativeGlass(v) {
  if (!("__TAURI_INTERNALS__" in window || "__TAURI__" in window)) return;
  import("@tauri-apps/api/core").then((m) => m.invoke("set_glass", { on: v })).catch(() => { /* not in a Tauri window */ });
}
export function setGlass(v) {
  localStorage.setItem(GLASS_KEY, v ? "1" : "0");
  glassStore.set(v);
  syncNativeGlass(v);
}
export function applyGlass() {
  syncNativeGlass(glassStore.get());
}

// Panel opacity for glass mode (0–100%). Feeds the CSS `--glass-opacity`
// var via an inline style on the .pr-root wrapper (see app.jsx).
const GLASS_OPACITY_KEY = "praetorium.glassOpacity";
const storedOpacity = Number(localStorage.getItem(GLASS_OPACITY_KEY));
export const glassOpacityStore = createStore(
  Number.isFinite(storedOpacity) && storedOpacity > 0 ? storedOpacity : 25);
export function setGlassOpacity(v) {
  const clamped = Math.max(0, Math.min(100, Math.round(v)));
  localStorage.setItem(GLASS_OPACITY_KEY, String(clamped));
  glassOpacityStore.set(clamped);
}

const LAYOUT_KEY = "praetorium.layout";
export const layoutNameStore = createStore(
  localStorage.getItem(LAYOUT_KEY) || "hierarchical");
export function setLayout(v) {
  localStorage.setItem(LAYOUT_KEY, v);
  layoutNameStore.set(v);
}
