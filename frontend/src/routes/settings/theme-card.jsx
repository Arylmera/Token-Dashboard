import React from "react";
import { THEMES } from "../../theme.js";

const ThemeSwatch = ({ theme, active, onPick }) => {
  const sw = theme.swatch || {};
  return (
    <button
      type="button"
      className={`a-theme-swatch ${active ? "is-active" : ""}`}
      onClick={onPick}
      title={theme.label}
      aria-pressed={active}
    >
      <span
        className="a-theme-swatch-preview"
        style={{ background: sw.bg, borderColor: active ? sw.accent : undefined }}
      >
        <span className="a-tspw-bar" style={{ background: sw.panel }} />
        <span className="a-tspw-bar2" style={{ background: sw.fg, opacity: 0.55 }} />
        <span className="a-tspw-dot" style={{ background: sw.accent }} />
      </span>
      <span className="a-theme-swatch-label">{theme.label}</span>
    </button>
  );
};

export const ThemeCard = ({ themeIdx, onPickTheme }) => {
  const dark  = THEMES.map((t, i) => [t, i]).filter(([t]) => t.mode === "dark");
  const light = THEMES.map((t, i) => [t, i]).filter(([t]) => t.mode === "light");
  return (
    <section className="a-card">
      <div className="a-card-head"><h2>Theme</h2><span className="a-card-meta">appearance</span></div>
      <div className="a-theme-mode-row">
        <span className="a-label">Dark</span>
        <div className="a-theme-swatch-grid">
          {dark.map(([t, i]) => (
            <ThemeSwatch key={t.id} theme={t} active={themeIdx === i} onPick={() => onPickTheme(i)} />
          ))}
        </div>
      </div>
      <div className="a-theme-mode-row">
        <span className="a-label">Light</span>
        <div className="a-theme-swatch-grid">
          {light.map(([t, i]) => (
            <ThemeSwatch key={t.id} theme={t} active={themeIdx === i} onPick={() => onPickTheme(i)} />
          ))}
        </div>
      </div>
    </section>
  );
};
