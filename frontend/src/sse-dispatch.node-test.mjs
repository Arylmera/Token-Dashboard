// node --test runner for the pure SSE hint dispatcher.
// Run with: cd frontend && node --test src/sse-dispatch.node-test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { pickEntries, pickStaticEntries } from "./sse-dispatch.js";

const REG = [
  { key: "any1",      trigger: "any" },
  { key: "static1",   trigger: "static" },
  { key: "sessions1", trigger: "sessions" },
  { key: "projects1", trigger: "projects" },
  { key: "models1",   trigger: "models" },
  { key: "daysFixed", trigger: "days", windowSince: () => "2026-05-01T00:00:00Z" },
  { key: "daysRange", trigger: "days", windowSince: (r) => r },
];

const sorted = (a) => a.slice().sort();
const eq = (got, exp) => assert.deepEqual(sorted(got), sorted(exp));

test("empty hint returns only 'any' entries", () => {
  eq(pickEntries(REG, {}, null), ["any1"]);
});

test("null hint behaves like empty hint", () => {
  eq(pickEntries(REG, null, null), ["any1"]);
});

test("sessions-only hint adds the sessions entry", () => {
  eq(pickEntries(REG, { sessions: ["s1"] }, null), ["any1", "sessions1"]);
});

test("projects-only hint adds the projects entry", () => {
  eq(pickEntries(REG, { projects: ["p1"] }, null), ["any1", "projects1"]);
});

test("models-only hint adds the models entry", () => {
  eq(pickEntries(REG, { models: ["m1"] }, null), ["any1", "models1"]);
});

test("days hint touching the fixed window picks both days entries", () => {
  eq(
    pickEntries(REG, { days: ["2026-05-09"] }, null),
    ["any1", "daysFixed", "daysRange"],
  );
});

test("days outside fixed window with active range bound returns only 'any'", () => {
  eq(
    pickEntries(REG, { days: ["2026-04-01"] }, "2026-05-01T00:00:00Z"),
    ["any1"],
  );
});

test("days inside range bound picks both days entries", () => {
  eq(
    pickEntries(REG, { days: ["2026-05-09"] }, "2026-05-08T00:00:00Z"),
    ["any1", "daysFixed", "daysRange"],
  );
});

test("day equal to since boundary matches (>= semantics)", () => {
  // daysRange uses range as-is; with a range-bound entry only, equality must include.
  const reg = [
    { key: "any1",      trigger: "any" },
    { key: "daysRange", trigger: "days", windowSince: (r) => r },
  ];
  eq(
    pickEntries(reg, { days: ["2026-05-01"] }, "2026-05-01T00:00:00Z"),
    ["any1", "daysRange"],
  );
});

test("days hint with empty days array does not pick days entries", () => {
  eq(pickEntries(REG, { days: [] }, null), ["any1"]);
});

test("days entry with unbounded window (since == null) always picks", () => {
  const reg = [
    { key: "daysUnbounded", trigger: "days", windowSince: () => null },
  ];
  eq(pickEntries(reg, { days: ["2020-01-01"] }, null), ["daysUnbounded"]);
});

test("daysMax picks the latest day from the hint", () => {
  // Latest day is 2026-05-09 — should be inside fixed window 2026-05-01.
  eq(
    pickEntries(REG, { days: ["2026-04-01", "2026-05-09", "2026-04-15"] }, null),
    ["any1", "daysFixed", "daysRange"],
  );
});

test("pickStaticEntries returns only static keys", () => {
  eq(pickStaticEntries(REG), ["static1"]);
});

test("pickStaticEntries returns exactly the 5 static keys when registry has 5", () => {
  const reg = [
    { key: "planResp",   trigger: "static" },
    { key: "limitsResp", trigger: "static" },
    { key: "budgetResp", trigger: "static" },
    { key: "tagsResp",   trigger: "static" },
    { key: "prefsResp",  trigger: "static" },
    { key: "any1",       trigger: "any" },
  ];
  eq(
    pickStaticEntries(reg),
    ["planResp", "limitsResp", "budgetResp", "tagsResp", "prefsResp"],
  );
});
