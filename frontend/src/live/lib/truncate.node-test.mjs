import { test } from "node:test";
import assert from "node:assert/strict";
import { truncateText, MAX_TURN_CHARS } from "./truncate.js";

test("truncateText: leaves short text byte-identical", () => {
  assert.equal(truncateText("hello"), "hello");
});

test("truncateText: leaves text at exactly the cap untouched", () => {
  const exact = "x".repeat(MAX_TURN_CHARS);
  assert.equal(truncateText(exact), exact);
});

test("truncateText: cuts over-cap text and appends a marker naming the dropped count", () => {
  const long = "x".repeat(MAX_TURN_CHARS + 500);
  const out = truncateText(long);
  assert.ok(out.startsWith("x".repeat(MAX_TURN_CHARS)));
  assert.ok(out.includes("500"), `marker should name the dropped char count, got: ${out.slice(-60)}`);
  // The result must be bounded, not merely shorter than the input.
  assert.ok(out.length < MAX_TURN_CHARS + 60);
});

test("truncateText: passes through non-string input unchanged", () => {
  assert.equal(truncateText(undefined), undefined);
  assert.equal(truncateText(null), null);
});

test("MAX_TURN_CHARS: is a small absolute bound", () => {
  // Every test above sizes its input FROM the constant, so they stay green no
  // matter how far the cap is raised. This is the assertion that actually
  // bounds retained memory, and the one a careless bump has to trip over.
  assert.ok(MAX_TURN_CHARS <= 8000, `cap must stay small, got ${MAX_TURN_CHARS}`);
});
