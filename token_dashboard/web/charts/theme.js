// theme.js — shared ECharts theme constants and mount helper
//
// BASE/X_AXIS/Y_AXIS/TOOLTIP/PALETTE keep stable identity so chart modules can
// spread them into ECharts options. applyChartTheme() mutates them in place;
// callers must re-render their charts after a theme switch to pick up changes.

const DARK = {
  text:        '#E6EDF3',
  axis:        '#1F2630',
  label:       '#8B98A6',
  tooltipBg:   '#0F1419',
  tooltipBd:   '#283040',
  palette:     ['#4A9EFF', '#7C5CFF', '#3FB68B', '#E8A23B', '#E5484D', '#5BCEDA', '#F472B6'],
};

const LIGHT = {
  text:        '#1A2330',
  axis:        '#E2E7EE',
  label:       '#5A6573',
  // Tint matches --panel in light theme: slight cool cast, not raw white.
  tooltipBg:   '#FBFCFE',
  tooltipBd:   '#CFD6DF',
  palette:     ['#1E6FCC', '#5C3FE0', '#2E9870', '#C8821E', '#D43338', '#1F9AAA', '#D85FA0'],
};

const FORGE = {
  text:        '#F5E8D8',
  axis:        '#2E2218',
  label:       '#B89578',
  tooltipBg:   '#1A140E',
  tooltipBd:   '#3D2D1F',
  palette:     ['#FF8A3D', '#FF5C2E', '#FFB347', '#C8A24A', '#E5484D', '#B86B3A', '#FFD27F'],
};

const FOREST = {
  text:        '#E0F0E5',
  axis:        '#1B2E24',
  label:       '#8FB39C',
  tooltipBg:   '#0F1A14',
  tooltipBd:   '#264736',
  palette:     ['#4FCB7A', '#2EA66B', '#9CD66F', '#E8A23B', '#E5484D', '#5BCEDA', '#7C5CFF'],
};

export const PALETTE = [...DARK.palette];

export const BASE = {
  textStyle: { color: DARK.text, fontFamily: 'Inter' },
  color: PALETTE,
  grid: { left: 36, right: 12, top: 24, bottom: 24, containLabel: true },
};

export const X_AXIS = {
  axisLine:  { lineStyle: { color: DARK.axis } },
  axisLabel: { color: DARK.label },
  axisTick:  { show: false },
};

export const Y_AXIS = {
  axisLine:  { show: false },
  axisTick:  { show: false },
  splitLine: { lineStyle: { color: DARK.axis } },
  axisLabel: { color: DARK.label },
};

export const TOOLTIP = {
  trigger: 'axis',
  backgroundColor: DARK.tooltipBg,
  borderColor: DARK.tooltipBd,
  borderWidth: 1,
  textStyle: { color: DARK.text, fontFamily: 'Inter', fontSize: 12 },
  padding: [8, 12],
};

export function applyChartTheme(mode) {
  const t = ({ light: LIGHT, forge: FORGE, forest: FOREST }[mode]) || DARK;
  BASE.textStyle.color = t.text;
  X_AXIS.axisLine.lineStyle.color = t.axis;
  X_AXIS.axisLabel.color = t.label;
  Y_AXIS.splitLine.lineStyle.color = t.axis;
  Y_AXIS.axisLabel.color = t.label;
  TOOLTIP.backgroundColor = t.tooltipBg;
  TOOLTIP.borderColor = t.tooltipBd;
  TOOLTIP.textStyle.color = t.text;
  PALETTE.length = 0;
  PALETTE.push(...t.palette);
}

if (typeof document !== 'undefined') {
  applyChartTheme(document.documentElement.dataset.theme || 'dark');
}

export function mount(el) {
  const c = echarts.init(el, null, { renderer: 'svg' });
  window.addEventListener('resize', () => c.resize());
  return c;
}
