import React from "react";

/** Pill toggle — the canonical on/off control for a SettingRow. */
export function ToggleSwitch({ checked, label }) {
  return (
    <span
      className={["pr-switch", checked && "is-on"].filter(Boolean).join(" ")}
      role="switch"
      aria-checked={checked}
      aria-label={label}
    >
      <span className="pr-switch-thumb" />
    </span>
  );
}

/**
 * Canonical settings entry: a bordered row with a title, optional description,
 * and a control on the right. Pass `onToggle` for a toggle row (the whole row
 * is clickable and shows a pill switch); otherwise pass a `control` element
 * (button, etc.) for a static row.
 */
export function SettingRow({ title, desc, checked, onToggle, control }) {
  const interactive = onToggle !== undefined;
  const flip = () => onToggle?.(!checked);
  return (
    <div
      className={[
        "pr-setting-row",
        !!checked && "is-on",
        !interactive && "is-static",
      ]
        .filter(Boolean)
        .join(" ")}
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      onClick={interactive ? flip : undefined}
      onKeyDown={
        interactive
          ? (e) => {
              if (e.key === " " || e.key === "Enter") {
                e.preventDefault();
                flip();
              }
            }
          : undefined
      }
    >
      <div className="pr-setting-row-text">
        <div className="pr-setting-row-title">{title}</div>
        {desc && <div className="pr-setting-row-desc">{desc}</div>}
      </div>
      {interactive ? (
        <ToggleSwitch checked={!!checked} label={title} />
      ) : (
        control
      )}
    </div>
  );
}

/** Labeled range slider with an optional left/right legend. Units default to %. */
export function SettingSlider({ label, value, onInput, min, max, unit, legend }) {
  return (
    <div className="pr-setting-slider">
      <div className="pr-setting-slider-head">
        <span className="pr-setting-slider-label">{label}</span>
        <span className="pr-card-meta">
          {value}
          {unit ?? "%"}
        </span>
      </div>
      <input
        type="range"
        min={min ?? 0}
        max={max ?? 100}
        step="1"
        value={value}
        onChange={(e) => onInput(Number(e.currentTarget.value))}
      />
      {legend && (
        <div className="pr-setting-slider-legend">
          <span>{legend[0]}</span>
          <span>{legend[1]}</span>
        </div>
      )}
    </div>
  );
}
