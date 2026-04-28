import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadPricing, costFor, formatForUser } from '../src/pricing.js';

const PRICING_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'pricing.json'
);

let p;
before(() => {
  p = loadPricing(PRICING_PATH);
});

function u(overrides = {}) {
  return {
    input_tokens: 0, output_tokens: 0, cache_read_tokens: 0,
    cache_create_5m_tokens: 0, cache_create_1h_tokens: 0,
    ...overrides,
  };
}

test('known opus input cost', () => {
  const c = costFor('claude-opus-4-7', u({ input_tokens: 1_000_000 }), p);
  assert.ok(Math.abs(c.usd - 15) < 1e-4);
  assert.equal(c.estimated, false);
});

test('known sonnet output cost', () => {
  const c = costFor('claude-sonnet-4-6', u({ output_tokens: 1_000_000 }), p);
  assert.ok(Math.abs(c.usd - 15) < 1e-4);
});

test('unknown opus falls back', () => {
  const c = costFor('claude-opus-9-9-experimental', u({ input_tokens: 1_000_000 }), p);
  assert.ok(Math.abs(c.usd - 15) < 1e-4);
  assert.equal(c.estimated, true);
});

test('unknown unparseable returns null', () => {
  const c = costFor('custom-local-model', u({ input_tokens: 9999 }), p);
  assert.equal(c.usd, null);
});

test('cache_read cheaper than input', () => {
  const cIn = costFor('claude-opus-4-7', u({ input_tokens: 1_000_000 }), p);
  const cCr = costFor('claude-opus-4-7', u({ cache_read_tokens: 1_000_000 }), p);
  assert.ok(cCr.usd < cIn.usd);
});

test('api plan returns raw', () => {
  const out = formatForUser(12.34, 'api', p);
  assert.equal(out.display_usd, 12.34);
  assert.equal(out.subscription_usd, null);
});

test('pro plan returns subscription subtitle', () => {
  const out = formatForUser(12.34, 'pro', p);
  assert.equal(out.subscription_usd, 20);
  assert.ok(out.subtitle.includes('Pro'));
});
