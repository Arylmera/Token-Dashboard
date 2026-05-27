import React from "react";
import { LEVELS } from "../../levels.js";

// Segmented selector for the user's power level. Mirrors the DensityCard
// radiogroup pattern. `level` is an int 1..4; `onPick(int)` persists it.
export const LevelCard = ({ level, onPick, loaded, saving }) => {
  const current = LEVELS.find((l) => l.id === level) || LEVELS[0];
  return (
    <section className="a-card">
      <div className="a-card-head">
        <h2>Power level</h2>
        <span className="a-card-meta">{saving ? "saving…" : (loaded ? "how much of the dashboard is revealed" : "loading…")}</span>
      </div>
      <div className="a-density" role="radiogroup" aria-label="Power level">
        {LEVELS.map((l) => (
          <button
            key={l.id}
            type="button"
            role="radio"
            aria-checked={level === l.id}
            className={`a-density-btn ${level === l.id ? "is-on" : ""}`}
            onClick={() => onPick(l.id)}
          >
            {l.label}
          </button>
        ))}
      </div>
      <div className="a-setting-row-desc" style={{ marginTop: 8 }}>{current.blurb}</div>
    </section>
  );
};
