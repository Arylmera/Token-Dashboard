import { createStore } from "../stores/create-store.js";

/* Token Dashboard theme set. Bare "dark" is the baseline (no data-theme override). */
export const THEMES = [
  "dark", "dim", "forge", "forest", "dusk", "ocean", "matrix", "rose",
  "bb-dark", "cyber-dark", "paper", "linen", "mint", "lilac", "bb-light", "cyber-light",
  "terminal", "cockpit", "grimdark",
];

/* The three "special" themes go beyond a flat palette swap: they also override
   display fonts and drive a full-bleed ambient canvas (see AmbientCanvas). */
export const SPECIAL_THEMES = ["terminal", "cockpit", "grimdark"];
export const isSpecialTheme = (t) => SPECIAL_THEMES.includes(t);

/* Mini palette swatches [bg, panel, accent] for the theme picker chips. */
export const THEME_SWATCHES = {
  dark: ["#0A0E14", "#11171F", "#4A9EFF"],
  dim: ["#0F1318", "#13181F", "#4A9EFF"],
  forge: ["#14100C", "#1A140E", "#ED7E3F"],
  forest: ["#0C1410", "#0F1A14", "#5CBC7A"],
  dusk: ["#0F0D1A", "#171326", "#A77FF0"],
  ocean: ["#07131A", "#0B1B26", "#36C2C2"],
  matrix: ["#000805", "#031410", "#1FE26F"],
  rose: ["#1A0A12", "#22101A", "#F4598F"],
  "bb-dark": ["#0A0E08", "#12140F", "#DCC81A"],
  "cyber-dark": ["#0A0710", "#1A1B26", "#BB22BD"],
  paper: ["#F7F9FC", "#FFFFFF", "#2F7FDB"],
  linen: ["#F5EFE4", "#FCF7EC", "#A85528"],
  mint: ["#ECF6EF", "#F8FCF9", "#0F9669"],
  lilac: ["#F2EEF8", "#FAF7FF", "#7449F0"],
  "bb-light": ["#F4EFC8", "#FAF7DD", "#1F5C36"],
  "cyber-light": ["#F2EAE5", "#FBF5F2", "#BE2BBE"],
  terminal: ["#020806", "#04140D", "#36FF7A"],
  cockpit: ["#04080F", "#0A1A2C", "#00D4FF"],
  grimdark: ["#0A0807", "#181311", "#C8A24A"],
};

/* Display metadata for the Settings theme picker — label + DARK/LIGHT group. */
export const THEME_LIST = [
  { id: "dark", label: "BENCH", group: "dark", swatches: THEME_SWATCHES.dark },
  { id: "dim", label: "DIM", group: "dark", swatches: THEME_SWATCHES.dim },
  { id: "forge", label: "FORGE", group: "dark", swatches: THEME_SWATCHES.forge },
  { id: "forest", label: "FOREST", group: "dark", swatches: THEME_SWATCHES.forest },
  { id: "dusk", label: "DUSK", group: "dark", swatches: THEME_SWATCHES.dusk },
  { id: "ocean", label: "OCEAN", group: "dark", swatches: THEME_SWATCHES.ocean },
  { id: "matrix", label: "MATRIX", group: "dark", swatches: THEME_SWATCHES.matrix },
  { id: "rose", label: "ROSE", group: "dark", swatches: THEME_SWATCHES.rose },
  { id: "bb-dark", label: "BREAKING BAD", group: "dark", swatches: THEME_SWATCHES["bb-dark"] },
  { id: "cyber-dark", label: "CYBERPUNK", group: "dark", swatches: THEME_SWATCHES["cyber-dark"] },
  { id: "paper", label: "PAPER", group: "light", swatches: THEME_SWATCHES.paper },
  { id: "linen", label: "LINEN", group: "light", swatches: THEME_SWATCHES.linen },
  { id: "mint", label: "MINT", group: "light", swatches: THEME_SWATCHES.mint },
  { id: "lilac", label: "LILAC", group: "light", swatches: THEME_SWATCHES.lilac },
  { id: "bb-light", label: "BREAKING BAD", group: "light", swatches: THEME_SWATCHES["bb-light"] },
  { id: "cyber-light", label: "CYBERPUNK", group: "light", swatches: THEME_SWATCHES["cyber-light"] },
  { id: "terminal", label: "TERMINAL", group: "special", swatches: THEME_SWATCHES.terminal },
  { id: "cockpit", label: "COCKPIT", group: "special", swatches: THEME_SWATCHES.cockpit },
  { id: "grimdark", label: "GRIMDARK", group: "special", swatches: THEME_SWATCHES.grimdark },
];

export const THEMED_COPY = {
  terminal: {
    path: "C:\\PRAETORIUM", ps1: ">", cmd: "PRAETORIUM.EXE",
    nav: { console: "CONSOLE", cockpit: "COCKPIT", explorer: "EXPLORER", settings: "SETTINGS" },
  },
  cockpit: {
    path: "BRIDGE", ps1: "›", cmd: "PRAETORIUM.SYS",
    nav: { console: "COMMS", cockpit: "HELM", explorer: "CHARTS", settings: "CONFIG" },
  },
  grimdark: {
    path: "~/forge/vigil", ps1: "✠", cmd: "vigil",
    nav: { console: "LITANY", cockpit: "WARFORGE", explorer: "ARCHIVE", settings: "RUBRIC" },
  },
};

const KEY = "praetorium.theme";
const hasStorage = typeof localStorage !== "undefined";
function initial() {
  const stored = hasStorage ? localStorage.getItem(KEY) : null;
  return THEMES.includes(stored) ? stored : "forge";
}

export const themeStore = createStore(initial());

export const theme = () => themeStore.get();
export const getTheme = theme;

export function setTheme(t) {
  if (hasStorage) localStorage.setItem(KEY, t);
  themeStore.set(t);
}

/* Reactive copy overrides for the active theme; undefined for non-special themes. */
export const themedCopy = () => THEMED_COPY[themeStore.get()];
