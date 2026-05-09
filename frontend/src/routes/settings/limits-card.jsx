import React from "react";
import { SettingRow } from "./atoms.jsx";

export const LimitsToggleCard = ({ enabled, onChange, loaded, saving }) => (
  <section className="a-card">
    <div className="a-card-head">
      <h2>Plan limit estimates</h2>
      <span className="a-card-meta">{saving ? "saving…" : (loaded ? "rough community estimates" : "loading…")}</span>
    </div>
    <SettingRow
      title="Show 5h and weekly window usage"
      description="Anthropic doesn't publish exact token quotas — these caps are approximate and can be unreliable. Disabling hides the “Plan limits remaining” card on Overview and the 5h / Weekly options for the status indicator."
      checked={enabled}
      onChange={onChange}
    />
  </section>
);
