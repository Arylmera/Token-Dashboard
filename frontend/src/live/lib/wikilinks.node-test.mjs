import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveWikilinks } from "./wikilinks.js";

const idx = new Map([["terra", "Terra.md"], ["emperor", "Anamnesis/EMPEROR.md"]]);

test("resolveWikilinks: resolves a known link with data-rel", () => {
  const out = resolveWikilinks("see [[Terra]] now", idx);
  assert.ok(out.includes('data-rel="Terra.md"'));
  assert.ok(out.includes(">Terra</a>"));
});

test("resolveWikilinks: uses the alias as label", () => {
  const out = resolveWikilinks("[[EMPEROR|the law]]", idx);
  assert.ok(out.includes('data-rel="Anamnesis/EMPEROR.md"'));
  assert.ok(out.includes(">the law</a>"));
});

test("resolveWikilinks: renders unknown links as dim span", () => {
  const out = resolveWikilinks("[[Ghost]]", idx);
  assert.ok(out.includes("wikilink-unresolved"));
  assert.ok(!out.includes("<a"));
});
