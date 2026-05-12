import React, { useEffect, useState } from "react";
import { D } from "../data-store.js";
import { SettingsGroup } from "./settings/atoms.jsx";
import { ThemeCard } from "./settings/theme-card.jsx";
import { PlanCard, PricingTable } from "./settings/plan-card.jsx";
import { BadgeCard } from "./settings/badge-card.jsx";
import { LimitsToggleCard, LimitResetCard } from "./settings/limits-card.jsx";
import { BudgetCard } from "./settings/budget-card.jsx";
import { BackupCard } from "./settings/backup-card.jsx";
import { SourcesCard } from "./settings/sources-card.jsx";
import { GlassCard } from "./settings/glass-card.jsx";
import { WidgetCard } from "./settings/widget-card.jsx";
import { AdvancedModeCard, DensityCard, DeveloperCard, AboutCard, Glossary, MultiProviderCard } from "./settings/misc-cards.jsx";
import { broadcastAdvancedMode } from "../use-advanced-mode.js";

export const Settings = ({ themeIdx, onPickTheme }) => {
  const [plan, setPlan] = useState((D.plan && D.plan.plan) || "api");
  const [saving, setSaving] = useState(false);
  const [limitsEnabled, setLimitsEnabled] = useState(false);
  const [limitsSaving, setLimitsSaving] = useState(false);
  const [limitsLoaded, setLimitsLoaded] = useState(false);
  const [advancedMode, setAdvancedMode] = useState(false);
  const [advancedSaving, setAdvancedSaving] = useState(false);
  const [advancedLoaded, setAdvancedLoaded] = useState(false);
  const [multiProviderEnabled, setMultiProviderEnabled] = useState(false);
  const [multiProviderSaving, setMultiProviderSaving] = useState(false);
  const [multiProviderLoaded, setMultiProviderLoaded] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/preferences")
      .then((r) => r.json())
      .then((d) => {
        if (cancelled || !d) return;
        if (typeof d.limits_enabled === "boolean") setLimitsEnabled(d.limits_enabled);
        if (typeof d.advanced_mode === "boolean") setAdvancedMode(d.advanced_mode);
        if (typeof d.multi_provider_enabled === "boolean") setMultiProviderEnabled(d.multi_provider_enabled);
      })
      .catch(() => {})
      .finally(() => {
        if (cancelled) return;
        setLimitsLoaded(true);
        setAdvancedLoaded(true);
        setMultiProviderLoaded(true);
      });
    return () => { cancelled = true; };
  }, []);
  const onToggleAdvanced = async (next) => {
    setAdvancedMode(next);
    setAdvancedSaving(true);
    broadcastAdvancedMode(next);
    try {
      await fetch("/api/preferences", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ advanced_mode: next }),
      });
      if (window.RELOAD_STATIC) window.RELOAD_STATIC();
    } catch (_) {}
    setAdvancedSaving(false);
  };
  const onToggleMultiProvider = async (next) => {
    setMultiProviderEnabled(next);
    setMultiProviderSaving(true);
    try {
      await fetch("/api/preferences", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ multi_provider_enabled: next }),
      });
      if (window.RELOAD_STATIC) window.RELOAD_STATIC();
    } catch (_) {}
    setMultiProviderSaving(false);
  };
  const onToggleLimits = async (next) => {
    setLimitsEnabled(next);
    setLimitsSaving(true);
    try {
      await fetch("/api/preferences", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ limits_enabled: next }),
      });
      if (window.RELOAD_STATIC) window.RELOAD_STATIC();
    } catch (_) {}
    setLimitsSaving(false);
  };
  const onPick = async (id) => {
    setPlan(id);
    setSaving(true);
    try {
      await fetch("/api/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan: id }),
      });
    } catch (_) {}
    setSaving(false);
  };
  const showDev = typeof window !== "undefined" && window.td && typeof window.td.toggleDevTools === "function";
  return (
    <div className="a-route a-settings">
      <SettingsGroup title="Appearance" description="theme and window styling">
        <ThemeCard themeIdx={themeIdx} onPickTheme={onPickTheme} />
        <DensityCard />
        <GlassCard />
        <WidgetCard />
      </SettingsGroup>

      <SettingsGroup title="Pricing &amp; budgets" description="how cost and quotas are calculated">
        <PlanCard plan={plan} saving={saving} onPick={onPick} />
        <BudgetCard />
        <PricingTable readOnly={!advancedMode} />
      </SettingsGroup>

      <SettingsGroup title="Limits &amp; alerts" description="dock/menubar indicator">
        <BadgeCard limitsEnabled={advancedMode && limitsEnabled} />
      </SettingsGroup>

      <SettingsGroup title="Data" description="export, portability, and external sources">
        <BackupCard />
        <SourcesCard />
      </SettingsGroup>

      <SettingsGroup title="Advanced" description="reveal extra tabs and editable internals">
        <AdvancedModeCard
          enabled={advancedMode}
          onChange={onToggleAdvanced}
          loaded={advancedLoaded}
          saving={advancedSaving}
        />
        {advancedMode && (
          <LimitsToggleCard enabled={limitsEnabled} onChange={onToggleLimits} loaded={limitsLoaded} saving={limitsSaving} />
        )}
        {advancedMode && limitsEnabled && <LimitResetCard />}
        {advancedMode && (
          <MultiProviderCard
            enabled={multiProviderEnabled}
            onChange={onToggleMultiProvider}
            loaded={multiProviderLoaded}
            saving={multiProviderSaving}
          />
        )}
        {showDev && <DeveloperCard />}
      </SettingsGroup>

      <SettingsGroup title="Reference">
        <Glossary />
        <AboutCard />
      </SettingsGroup>
    </div>
  );
};
