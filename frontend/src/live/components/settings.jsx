import React from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { THEME_LIST, themeStore, setTheme } from "../themes/theme.js";
import { glassStore, setGlass, glassOpacityStore, setGlassOpacity, reduceMotionStore, setReduceMotion, applyReduceMotion } from "../stores/settings.js";
import { vaultPathStore, setVaultPath } from "../stores/vault-store.js";
import { useStore } from "../stores/use-store.js";
import { SettingRow, SettingSlider } from "./settings/atoms.jsx";

async function pickVault() {
  const result = await open({ directory: true, multiple: false });
  if (typeof result === "string") setVaultPath(result);
}

const lineColor = (group, strong) =>
  group === "light"
    ? `rgba(0,0,0,${strong ? 0.24 : 0.13})`
    : `rgba(255,255,255,${strong ? 0.22 : 0.11})`;

function ThemeChip({ info }) {
  const theme = useStore(themeStore);
  const [bg, panel, accent] = info.swatches;
  return (
    <button
      className={["pr-theme-chip", theme === info.id && "is-active"].filter(Boolean).join(" ")}
      onClick={() => setTheme(info.id)}
    >
      <span
        className="pr-theme-preview"
        style={{ background: `linear-gradient(180deg, ${panel} 0%, ${bg} 100%)` }}
      >
        <span className="line l1" style={{ background: lineColor(info.group, true) }} />
        <span className="line l2" style={{ background: lineColor(info.group, false) }} />
        <span className="dot" style={{ background: accent }} />
      </span>
      <span className="name">{info.label}</span>
    </button>
  );
}

function ThemeGrid({ group }) {
  return (
    <>
      <div className="pr-group-label">{group}</div>
      <div className="pr-theme-grid">
        {THEME_LIST.filter((t) => t.group === group).map((info) => (
          <ThemeChip key={info.id} info={info} />
        ))}
      </div>
    </>
  );
}

export function Settings() {
  const vaultPath = useStore(vaultPathStore);
  const glass = useStore(glassStore);
  const glassOpacity = useStore(glassOpacityStore);
  const reduceMotion = useStore(reduceMotionStore);

  return (
    <div className="pr-settings">
      {/* VAULT */}
      <section className="pr-set-card">
        <div className="pr-card-head">
          <h2>VAULT</h2>
          <span className="pr-card-meta">notes source directory</span>
        </div>
        <div className="pr-set-body">
          <div className="pr-set-section">
            <div className="pr-set-section-head">
              <span className="h">ROOT</span>
              <span className="meta">vault path</span>
            </div>
            <SettingRow
              title="Root directory"
              desc={<span className="pr-setting-row-path" title={vaultPath}>{vaultPath}</span>}
              control={<button className="pr-vault-change" onClick={pickVault}>Change…</button>}
            />
          </div>
        </div>
      </section>

      {/* APPEARANCE */}
      <section className="pr-set-card">
        <div className="pr-card-head">
          <h2>APPEARANCE</h2>
          <span className="pr-card-meta">theme and window styling</span>
        </div>
        <div className="pr-set-body">
          <div className="pr-set-section">
            <div className="pr-set-section-head">
              <span className="h">THEME</span>
              <span className="meta">color scheme</span>
            </div>
            <ThemeGrid group="dark" />
            <ThemeGrid group="light" />
            <ThemeGrid group="special" />
          </div>

          <div className="pr-set-section">
            <div className="pr-set-section-head">
              <span className="h">WINDOW</span>
              <span className="meta">chrome &amp; motion</span>
            </div>
            <SettingRow
              title="Translucent window"
              desc="Show desktop wallpaper through the app with a frosted-glass blur. macOS / Windows 11."
              checked={glass}
              onToggle={setGlass}
            />
            {glass && (
              <SettingSlider
                label="Panel opacity"
                value={glassOpacity}
                onInput={setGlassOpacity}
                legend={["more transparent", "more solid"]}
              />
            )}
            <SettingRow
              title="Reduce motion"
              desc="Disable scan-line sweep, pulses, and the blinking cursor."
              checked={reduceMotion}
              onToggle={(v) => { setReduceMotion(v); applyReduceMotion(); }}
            />
          </div>
        </div>
      </section>
    </div>
  );
}
