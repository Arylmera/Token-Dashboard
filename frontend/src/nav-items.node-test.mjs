import { test } from "node:test";
import assert from "node:assert/strict";
import { NAV_ITEMS } from "./nav-items.js";
import { TAB_MIN_LEVEL } from "./levels.js";

test("every nav item id has a power-level entry", () => {
  for (const item of NAV_ITEMS) {
    assert.ok(item.id in TAB_MIN_LEVEL || item.id === "overview" || item.id === "settings",
      `${item.id} missing from TAB_MIN_LEVEL`);
  }
});

test("nav order matches the legacy topbar order", () => {
  assert.deepEqual(
    NAV_ITEMS.map((i) => i.id),
    ["overview","budget","cache","prompts","sessions","calendar","tags","token sink","tips","api","settings"],
  );
});

test("each item has a short label and an icon", () => {
  for (const item of NAV_ITEMS) {
    assert.equal(typeof item.label, "string");
    assert.ok(item.label.length > 0);
    assert.ok(item.icon, `${item.id} missing icon`);
  }
});
