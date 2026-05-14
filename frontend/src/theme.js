export const THEMES = [
  { id: "bench",  label: "bench",  cls: "",              mode: "dark",
    swatch: { bg: "#0A0E14", panel: "#0F1419", accent: "#4A9EFF", fg: "#E6EDF3" } },
  { id: "forge",  label: "forge",  cls: "theme-forge",   mode: "dark",
    swatch: { bg: "#14100C", panel: "#1A140E", accent: "#FF8A3D", fg: "#F5E8D8" } },
  { id: "forest", label: "forest", cls: "theme-forest",  mode: "dark",
    swatch: { bg: "#0C1410", panel: "#0F1A14", accent: "#4FCB7A", fg: "#E0F0E5" } },
  { id: "dusk",   label: "dusk",   cls: "theme-dusk",    mode: "dark",
    swatch: { bg: "#0F0D1A", panel: "#171326", accent: "#B68CFF", fg: "#ECE6FF" } },
  { id: "ocean",  label: "ocean",  cls: "theme-ocean",   mode: "dark",
    swatch: { bg: "#07131A", panel: "#0B1B26", accent: "#3DD4D4", fg: "#DCEFF7" } },
  { id: "matrix",     label: "matrix",       cls: "theme-matrix",     mode: "dark",
    swatch: { bg: "#000805", panel: "#031410", accent: "#00FF66", fg: "#B8FFD0" } },
  { id: "rose",       label: "rose",         cls: "theme-rose",       mode: "dark",
    swatch: { bg: "#1A0A12", panel: "#22101A", accent: "#FF4D8A", fg: "#FFE2EC" } },
  { id: "bb-dark",    label: "breaking bad", cls: "theme-bb-dark",    mode: "dark",
    swatch: { bg: "#0A0E08", panel: "#12140F", accent: "#E9D71B", fg: "#F0E8B8" } },
  { id: "cyber-dark", label: "cyberpunk",    cls: "theme-cyber-dark", mode: "dark",
    swatch: { bg: "#0A0710", panel: "#1A1B26", accent: "#CB1DCD", fg: "#D1C5C0" } },
  { id: "paper",      label: "paper",        cls: "theme-paper",      mode: "light",
    swatch: { bg: "#F7F9FC", panel: "#FFFFFF", accent: "#2B7FE0", fg: "#1A2330" } },
  { id: "linen",      label: "linen",        cls: "theme-linen",      mode: "light",
    swatch: { bg: "#F5EFE4", panel: "#FCF7EC", accent: "#B85C28", fg: "#3A2E1C" } },
  { id: "mint",       label: "mint",         cls: "theme-mint",       mode: "light",
    swatch: { bg: "#ECF6EF", panel: "#F8FCF9", accent: "#0E9F6E", fg: "#1B3A2A" } },
  { id: "lilac",      label: "lilac",        cls: "theme-lilac",      mode: "light",
    swatch: { bg: "#F2EEF8", panel: "#FAF7FF", accent: "#7C4DFF", fg: "#2D1F47" } },
  { id: "bb-light",   label: "breaking bad", cls: "theme-bb-light",   mode: "light",
    swatch: { bg: "#F4EFC8", panel: "#FAF7DD", accent: "#1B5530", fg: "#12140F" } },
  { id: "cyber-light", label: "cyberpunk",   cls: "theme-cyber-light", mode: "light",
    swatch: { bg: "#F2EAE5", panel: "#FBF5F2", accent: "#CB1DCD", fg: "#272932" } },
];

const THEME_KEY = "td.theme.v2";

export const themeIndexFromId = (id) => {
  const i = THEMES.findIndex((t) => t.id === id);
  return i >= 0 ? i : -1;
};

export const themeIndexFromStorage = () => {
  try {
    const i = themeIndexFromId(localStorage.getItem(THEME_KEY));
    return i >= 0 ? i : 0;
  } catch (_) { return 0; }
};

export const persistThemeIndex = (idx) => {
  try { localStorage.setItem(THEME_KEY, THEMES[idx].id); } catch (_) {}
};

// Tauri picks a free port per launch, so the webview origin changes and
// localStorage is not portable across runs. Mirror the choice into the
// backend preferences DB so the next launch can rehydrate it.
export const persistThemeBackend = (idx) => {
  const id = THEMES[idx]?.id;
  if (!id) return;
  try {
    fetch("/api/preferences", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ theme: id }),
    }).catch(() => {});
  } catch (_) {}
};

export const applyThemeClass = (idx) => {
  const root = document.querySelector(".dir-a-root");
  if (!root) return;
  THEMES.forEach((t) => { if (t.cls) root.classList.remove(t.cls); });
  const cls = THEMES[idx].cls;
  if (cls) root.classList.add(cls);
};
