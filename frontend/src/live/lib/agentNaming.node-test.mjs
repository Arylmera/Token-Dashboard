import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAgentNames } from "./agentNaming.js";

test("buildAgentNames: uses the subagent type when unique", () => {
  const names = buildAgentNames(["r1"], (r) => (r === "r1" ? "Explore" : undefined));
  assert.equal(names.get("r1"), "Explore");
});

test("buildAgentNames: numbers duplicate types in first-seen order", () => {
  const typeOf = (r) => (r === "r1" || r === "r2" ? "Explore" : undefined);
  const names = buildAgentNames(["r1", "r2"], typeOf);
  assert.equal(names.get("r1"), "Explore 1");
  assert.equal(names.get("r2"), "Explore 2");
});

test("buildAgentNames: falls back to sequential generic names when no type", () => {
  const names = buildAgentNames(["r1", "r2"], () => undefined);
  assert.equal(names.get("r1"), "agent 1");
  assert.equal(names.get("r2"), "agent 2");
});
