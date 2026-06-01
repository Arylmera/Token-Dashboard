import { test } from "node:test";
import assert from "node:assert/strict";
import { viewStore, setView } from "./view-store.js";

test("viewStore: initial value is 'console'", () => {
  assert.equal(viewStore.get(), "console");
});

test("viewStore: setView updates the store", () => {
  setView("explorer");
  assert.equal(viewStore.get(), "explorer");
  setView("console");
  assert.equal(viewStore.get(), "console");
});
