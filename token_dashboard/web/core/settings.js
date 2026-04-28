// settings.js — user preferences (theme, future toggles) persisted to localStorage

import { applyChartTheme } from '/web/charts/theme.js';

export const THEMES = ['dark', 'light', 'forge', 'forest'];
const THEME_KEY = 'td.theme';

export function getTheme() {
  const v = localStorage.getItem(THEME_KEY);
  return THEMES.includes(v) ? v : 'dark';
}

export function setTheme(mode) {
  const next = THEMES.includes(mode) ? mode : 'dark';
  localStorage.setItem(THEME_KEY, next);
  document.documentElement.dataset.theme = next;
  applyChartTheme(next);
  return next;
}
