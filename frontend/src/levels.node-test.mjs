import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LEVELS, TAB_MIN_LEVEL, CARD_MIN_LEVEL,
  tabVisible, cardVisible, clampLevel,
} from "./levels.js";

const ALL_TABS = ["overview","budget","cache","prompts","sessions","calendar","tags","token sink","tips","api","settings"];

test("there are exactly 4 levels", () => {
  assert.equal(LEVELS.length, 4);
  assert.deepEqual(LEVELS.map((l) => l.id), [1, 2, 3, 4]);
});

test("every tab has a min level", () => {
  for (const t of ALL_TABS) assert.ok(TAB_MIN_LEVEL[t] != null, `missing tab: ${t}`);
});

test("overview and settings are visible at Basic", () => {
  assert.ok(tabVisible(1, "overview"));
  assert.ok(tabVisible(1, "settings"));
});

test("api tab requires Expert", () => {
  assert.equal(tabVisible(3, "api"), false);
  assert.ok(tabVisible(4, "api"));
});

test("Expert sees every tab and card", () => {
  for (const t of ALL_TABS) assert.ok(tabVisible(4, t), `hidden tab: ${t}`);
  for (const k of Object.keys(CARD_MIN_LEVEL)) assert.ok(cardVisible(4, k), `hidden card: ${k}`);
});

test("basic Overview shows the essentials only", () => {
  assert.ok(cardVisible(1, "topStrip"));
  assert.ok(cardVisible(1, "burnRateCard"));
  assert.equal(cardVisible(1, "kpiRow"), false);
  assert.equal(cardVisible(1, "anomaly"), false);
});

test("clampLevel bounds and defaults", () => {
  assert.equal(clampLevel(0), 1);
  assert.equal(clampLevel(99), 4);
  assert.equal(clampLevel("3"), 3);
  assert.equal(clampLevel(undefined), 1);
});
