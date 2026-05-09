import React, { useEffect, useState } from "react";
import { SettingRow } from "./atoms.jsx";

const isElectronApp = () => typeof window !== "undefined" && !!window.td;

const applyGlassClass = (on) => {
  const root = document.querySelector(".dir-a-root");
  if (!root) return;
  // Glass requires a transparent OS-level window (vibrancy/acrylic). In a
  // plain browser, stripping the body background would just reveal white,
  // so never apply the class outside the Electron app.
  root.classList.toggle("is-glass", !!on && isElectronApp());
};

const applyGlassOpacity = (pct) => {
  const root = document.querySelector(".dir-a-root");
  if (!root) return;
  root.style.setProperty("--glass-opacity", `${Math.max(0, Math.min(100, pct))}%`);
};

export const GlassCard = () => {
  const [enabled, setEnabled] = useState(false);
  const [opacity, setOpacity] = useState(25);
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/preferences")
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        const on = !!(d && d.glass_enabled);
        const op = (d && typeof d.glass_opacity === "number") ? d.glass_opacity : 25;
        setEnabled(on);
        setOpacity(op);
        applyGlassClass(on);
        applyGlassOpacity(op);
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, []);
  const persist = async (body) => {
    setSaving(true);
    try {
      await fetch("/api/preferences", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (_) {}
    setSaving(false);
  };
  const onToggle = (next) => {
    setEnabled(next);
    applyGlassClass(next);
    try { if (window.td && window.td.setGlass) window.td.setGlass(next); } catch (_) {}
    persist({ glass_enabled: next });
  };
  const onSlide = (e) => {
    const v = parseInt(e.target.value, 10);
    setOpacity(v);
    applyGlassOpacity(v);
  };
  const onSlideCommit = (e) => {
    const v = parseInt(e.target.value, 10);
    persist({ glass_opacity: v });
  };
  const isElectron = isElectronApp();
  const note = isElectron
    ? "translucent window with native blur (macOS / Windows 11)"
    : "only available in the desktop app";
  return (
    <section className="a-card">
      <div className="a-card-head">
        <h2>Glass effect</h2>
        <span className="a-card-meta">{saving ? "saving…" : (loaded ? note : "loading…")}</span>
      </div>
      <SettingRow
        title="Translucent window"
        description="Show desktop wallpaper through the dashboard with a frosted-glass blur."
        checked={enabled}
        onChange={onToggle}
      />
      {enabled && (
        <div className="a-glass-slider">
          <div className="a-glass-slider-head">
            <span className="a-label">Panel opacity</span>
            <span className="a-card-meta mono">{opacity}%</span>
          </div>
          <input
            type="range"
            min="0"
            max="100"
            step="1"
            value={opacity}
            onChange={onSlide}
            onMouseUp={onSlideCommit}
            onTouchEnd={onSlideCommit}
            onKeyUp={onSlideCommit}
          />
          <div className="a-glass-slider-legend">
            <span>more transparent</span>
            <span>more solid</span>
          </div>
        </div>
      )}
    </section>
  );
};
