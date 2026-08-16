import React from "react";
import { D } from "../data-store.js";
import { fmtCost, fmtCostWhole, fmtNum, fmtPct, fmtTokens } from "../format.js";
import { KPI } from "../components/atoms.jsx";
import { StripSpark } from "../components/charts.jsx";
import { CountUp } from "../components/count-up.jsx";
import { getThemedCopy } from "../themed-copy.js";
import { cardVisible } from "../levels.js";
import { BudgetAlertBanner, BudgetBanner, ScanErrorBanner } from "./overview/banners.jsx";
import { BurnRateCard } from "./overview/burn-rate.jsx";
import { LimitsCard } from "./overview/limits.jsx";
import { PhaseSplitCard } from "./overview/phase-split.jsx";
import { TopStrip } from "./overview/top-strip.jsx";
import { DailyCharts, rangeDaysFromKey } from "./overview/daily-charts.jsx";
import { ProjectsTable } from "./overview/projects-table.jsx";
import { ModelLeaderboard, ModelsCard } from "./overview/models.jsx";
import { TopToolsCard } from "./overview/top-tools.jsx";
import { AnomalyCard } from "./overview/anomaly.jsx";
import { RecentSessions } from "./overview/recent-sessions.jsx";

const sparkOf = (daily, days, pick) => {
  const fn = pick || ((d) => Number(d.cost) || 0);
  const arr = (daily || []).map(fn);
  if (!arr.length) return null;
  const slice = Number.isFinite(days) ? arr.slice(-days) : arr;
  if (slice.length < 2) return null;
  return slice;
};

const KpiSpark = ({ daily, days, pick, accent }) => {
  const data = sparkOf(daily, days, pick);
  if (!data) return null;
  return (
    <div className="a-kpi-spark">
      <StripSpark data={data} height={22} accent={accent || "var(--accent)"} />
    </div>
  );
};

const cacheHitOf = (d) => {
  const reads = Number(d.cacheRead) || 0;
  const billed = (Number(d.input) || 0) + (Number(d.output) || 0);
  const total = reads + billed;
  return total > 0 ? reads / total : 0;
};

const KpiRow = ({ totals, tc }) => {
  const t = totals;
  const daily = D.daily || [];
  const rangeDays = rangeDaysFromKey(t.rangeKey);
  // 1-day range only has a single daily bucket — fall back to the
  // 24-slot hourly series so input/output/cache-hit sparks have
  // enough points to draw a line.
  const useHourly = rangeDays === 1;
  const ioSeries = useHourly ? (D.hourlyDetail || []) : daily;
  const ioDays = useHourly ? 24 : rangeDays;
  const plusKey = t.plusKey || "all";
  const plusDays = rangeDaysFromKey(plusKey);
  const plusDaily = D.dailyPlus || daily;
  const plusUseHourly = plusDays === 1;
  const plusSparkData = plusUseHourly ? (D.hourlyDetail || []) : plusDaily;
  const plusSparkDays = plusUseHourly ? 24 : plusDays;
  const plusAvg = Number.isFinite(plusDays) && plusDays > 0
    ? `avg ${fmtCost((t.plusCost || 0) / plusDays)}/day`
    : `${fmtNum(t.turns)} turns`;
  const windows = [
    {
      key: "range",
      label: t.rangeLabel || "range",
      value: <CountUp to={t.range || 0} format={fmtCostWhole} />,
      sub: `${fmtTokens(t.rangeTokens)} tok · ${t.rangeSessions || 0} sessions`,
      sparkData: useHourly ? (D.hourlyDetail || []) : daily,
      sparkDays: useHourly ? 24 : rangeDays,
    },
    {
      key: "plus",
      label: t.plusLabel || "plus",
      value: <CountUp to={t.plusCost || 0} format={fmtCostWhole} />,
      sub: `${fmtTokens(t.plusTokens || 0)} tok · ${plusAvg}`,
      sparkData: plusSparkData,
      sparkDays: plusSparkDays,
    },
  ];
  return (
    <section className="a-kpi-row">
      {windows.map((w) => (
        <KPI
          key={w.key}
          label={w.label}
          value={w.value}
          sub={w.sub}
          spark={<KpiSpark daily={w.sparkData} days={w.sparkDays} />}
        />
      ))}
      <KPI
        label="input"
        value={<CountUp to={t.inputTokens || 0} format={fmtTokens} />}
        sub={`tokens · ${t.rangeLabel || "range"}`}
        spark={<KpiSpark daily={ioSeries} days={ioDays} pick={(d) => Number(d.input) || 0} />}
      />
      <KPI
        label="output"
        value={<CountUp to={t.outputTokens || 0} format={fmtTokens} />}
        sub={`tokens · ${t.rangeLabel || "range"}`}
        spark={<KpiSpark daily={ioSeries} days={ioDays} pick={(d) => Number(d.output) || 0} />}
      />
      <KPI
        label={tc?.kpi?.["cache hit"] ?? "cache hit"}
        value={<CountUp to={t.cacheHitRate || 0} format={fmtPct} />}
        sub={`last ${t.rangeLabel || "range"}`}
        spark={<KpiSpark daily={ioSeries} days={ioDays} pick={cacheHitOf} />}
      />
    </section>
  );
};

export const Overview = ({ themeId, level = 1 }) => {
  const totals = D.totals;
  const burn = D.burn;
  const tc = getThemedCopy(themeId);
  const show = (k) => cardVisible(level, k);
  const showProjectsRow = show("projectsTable") || show("modelsCard") || show("modelLeaderboard");
  const showPhaseRow = show("phaseSplit") || show("topTools");
  return (
    <div className="a-route">
      {/* Not gated by power level: stale-because-broken must reach every user. */}
      <ScanErrorBanner />
      {show("topStrip") && <TopStrip totals={totals} burn={burn} />}
      {show("budgetAlertBanner") && <BudgetAlertBanner />}
      {show("budgetBanner") && <BudgetBanner budget={D.budget} />}
      {show("limitsCard") && <LimitsCard limits={D.limits} enabled={!!(D.prefs && D.prefs.limits_enabled)} />}
      {show("burnRateCard") && <BurnRateCard />}
      {show("kpiRow") && <KpiRow totals={totals} tc={tc} />}
      {show("dailyCharts") && <DailyCharts totals={totals} />}
      {showProjectsRow && (
        <section className="a-card-row">
          {show("projectsTable") && <ProjectsTable totals={totals} />}
          {show("modelsCard") && <ModelsCard tc={tc} />}
          {show("modelLeaderboard") && <ModelLeaderboard />}
        </section>
      )}
      {showPhaseRow && (
        <section className="a-card-row">
          {show("phaseSplit") && <PhaseSplitCard phase={D.phase} />}
          {show("topTools") && <TopToolsCard />}
        </section>
      )}
      {show("anomaly") && <AnomalyCard />}
      {show("recentSessions") && <RecentSessions tc={tc} />}
    </div>
  );
};
