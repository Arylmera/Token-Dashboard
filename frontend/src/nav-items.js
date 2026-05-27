// Nav items data module — tab order, labels, and icons.
// Authored as plain JS (React.createElement, no JSX) so node --test can load
// this file directly without a JSX transform.
import React from "react";

const svg = (...children) =>
  React.createElement(
    "svg",
    { width: 16, height: 16, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round" },
    ...children,
  );
const path = (d) => React.createElement("path", { d });
const rect = (attrs) => React.createElement("rect", attrs);
const circle = (attrs) => React.createElement("circle", attrs);

// overview — 2×2 grid
const iconOverview = svg(
  rect({ x: 1, y: 1, width: 6, height: 6, rx: 1 }),
  rect({ x: 9, y: 1, width: 6, height: 6, rx: 1 }),
  rect({ x: 1, y: 9, width: 6, height: 6, rx: 1 }),
  rect({ x: 9, y: 9, width: 6, height: 6, rx: 1 }),
);

// budget — bar chart
const iconBudget = svg(
  path("M1 13h3V7H1v6zM6 13h3V4H6v9zm5 0h3V1h-3v12z"),
);

// cache — cylinder
const iconCache = svg(
  path("M2 4.5C2 3.12 5.13 2 8 2s6 1.12 6 2.5v7C14 10.88 10.87 12 8 12S2 10.88 2 11.5v-7z"),
  path("M2 4.5C2 5.88 5.13 7 8 7s6-1.12 6-2.5"),
);

// prompts — speech bubble
const iconPrompts = svg(
  path("M2 3a1 1 0 011-1h10a1 1 0 011 1v7a1 1 0 01-1 1H5l-3 3V3z"),
);

// sessions — clock
const iconSessions = svg(
  circle({ cx: 8, cy: 8, r: 6 }),
  path("M8 5v3l2 2"),
);

// calendar
const iconCalendar = svg(
  rect({ x: 2, y: 3, width: 12, height: 11, rx: 1 }),
  path("M5 2v2M11 2v2M2 7h12"),
);

// tags — tag shape
const iconTags = svg(
  path("M2 2h5l7 7-5 5L2 7V2z"),
  circle({ cx: 5.5, cy: 5.5, r: 1 }),
);

// token sink — funnel
const iconTokenSink = svg(
  path("M2 2h12l-5 6v5l-2-1V8L2 2z"),
);

// tips — lightbulb
const iconTips = svg(
  path("M8 2a4 4 0 014 4c0 1.8-1 3.3-2.5 4.1V12h-3v-1.9C5 9.3 4 7.8 4 6a4 4 0 014-4z"),
  path("M6 14h4"),
);

// api — angle brackets
const iconApi = svg(
  path("M5 4L1 8l4 4M11 4l4 4-4 4M9 2l-2 12"),
);

// settings — cog wheel
const iconSettings = React.createElement(
  "svg",
  { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round" },
  path("M10.325 4.317c.426 -1.756 2.924 -1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543 -.94 3.31 .826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756 .426 1.756 2.924 0 3.35a1.724 1.724 0 0 0 -1.066 2.573c.94 1.543 -.826 3.31 -2.37 2.37a1.724 1.724 0 0 0 -2.572 1.065c-.426 1.756 -2.924 1.756 -3.35 0a1.724 1.724 0 0 0 -2.573 -1.066c-1.543 .94 -3.31 -.826 -2.37 -2.37a1.724 1.724 0 0 0 -1.065 -2.572c-1.756 -.426 -1.756 -2.924 0 -3.35a1.724 1.724 0 0 0 1.066 -2.573c-.94 -1.543 .826 -3.31 2.37 -2.37c1 .608 2.296 .07 2.572 -1.065z"),
  circle({ cx: 12, cy: 12, r: 3 }),
);

export const NAV_ITEMS = [
  { id: "overview",    label: "overview",   icon: iconOverview },
  { id: "budget",      label: "budget",     icon: iconBudget },
  { id: "cache",       label: "cache",      icon: iconCache },
  { id: "prompts",     label: "prompts",    icon: iconPrompts },
  { id: "sessions",    label: "sessions",   icon: iconSessions },
  { id: "calendar",    label: "calendar",   icon: iconCalendar },
  { id: "tags",        label: "tags",       icon: iconTags },
  { id: "token sink",  label: "sink",       icon: iconTokenSink },
  { id: "tips",        label: "tips",       icon: iconTips },
  { id: "api",         label: "api",        icon: iconApi },
  { id: "settings",    label: "settings",   icon: iconSettings },
];
