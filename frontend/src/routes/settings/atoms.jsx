import React from "react";

export const Toggle = ({ checked, onChange, ariaLabel }) => (
  <button
    type="button"
    role="switch"
    aria-checked={!!checked}
    aria-label={ariaLabel}
    className={`a-toggle ${checked ? "is-on" : ""}`}
    onClick={(e) => { e.preventDefault(); e.stopPropagation(); onChange(!checked); }}
  >
    <span className="a-toggle-thumb" />
  </button>
);

export const SettingRow = ({ title, description, checked, onChange }) => (
  <div
    className={`a-setting-row ${checked ? "is-on" : ""}`}
    role="button"
    tabIndex={0}
    onClick={() => onChange(!checked)}
    onKeyDown={(e) => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); onChange(!checked); } }}
  >
    <div className="a-setting-row-text">
      <div className="a-setting-row-title">{title}</div>
      {description && <div className="a-setting-row-desc">{description}</div>}
    </div>
    <Toggle checked={checked} onChange={onChange} ariaLabel={title} />
  </div>
);

export const SettingsGroup = ({ title, description, children }) => (
  <div className="a-settings-group">
    <div className="a-settings-group-head">
      <span className="a-settings-group-title">{title}</span>
      {description && <span className="a-settings-group-desc">{description}</span>}
    </div>
    <div className="a-settings-group-body">{children}</div>
  </div>
);
