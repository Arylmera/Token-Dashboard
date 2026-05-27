import { test } from "node:test";
import assert from "node:assert/strict";
import { RESIZE_EDGES, resizeDirectionFor } from "./tauri-window.js";

test("every edge maps to a Tauri ResizeDirection string", () => {
  for (const edge of RESIZE_EDGES) {
    assert.equal(typeof resizeDirectionFor(edge), "string");
  }
});

test("corner + side directions are correct", () => {
  assert.equal(resizeDirectionFor("n"), "North");
  assert.equal(resizeDirectionFor("se"), "SouthEast");
  assert.equal(resizeDirectionFor("w"), "West");
});

test("unknown edge returns null", () => {
  assert.equal(resizeDirectionFor("xyz"), null);
});
