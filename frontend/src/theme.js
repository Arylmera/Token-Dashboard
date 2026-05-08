export const THEMES = [
  { id: "bench",  label: "bench",  cls: "" },
  { id: "forge",  label: "forge",  cls: "theme-forge" },
  { id: "forest", label: "forest", cls: "theme-forest" },
  { id: "paper",  label: "paper",  cls: "theme-light" },
];

const THEME_KEY = "td.theme.v2";

export const themeIndexFromStorage = () => {
  try {
    const id = localStorage.getItem(THEME_KEY);
    const i = THEMES.findIndex((t) => t.id === id);
    return i >= 0 ? i : 0;
  } catch (_) { return 0; }
};

export const persistThemeIndex = (idx) => {
  try { localStorage.setItem(THEME_KEY, THEMES[idx].id); } catch (_) {}
};

export const applyThemeClass = (idx) => {
  const root = document.querySelector(".dir-a-root");
  if (!root) return;
  THEMES.forEach((t) => { if (t.cls) root.classList.remove(t.cls); });
  const cls = THEMES[idx].cls;
  if (cls) root.classList.add(cls);
};
