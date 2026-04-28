import fs from 'node:fs';

import { withDb } from './db.js';

export function loadPricing(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function tierFromName(model) {
  const m = (model || '').toLowerCase();
  for (const tier of ['opus', 'sonnet', 'haiku']) {
    if (m.includes(tier)) return tier;
  }
  return null;
}

export function costFor(model, usage, pricing) {
  let rates = pricing.models[model];
  let estimated = false;
  if (!rates) {
    const tier = tierFromName(model || '');
    if (tier && pricing.tier_fallback[tier]) {
      rates = pricing.tier_fallback[tier];
      estimated = true;
    } else {
      return { usd: null, estimated: true, breakdown: {} };
    }
  }
  const bd = {
    input: (Number(usage.input_tokens || 0) * rates.input) / 1_000_000,
    output: (Number(usage.output_tokens || 0) * rates.output) / 1_000_000,
    cache_read: (Number(usage.cache_read_tokens || 0) * rates.cache_read) / 1_000_000,
    cache_create_5m:
      (Number(usage.cache_create_5m_tokens || 0) * rates.cache_create_5m) / 1_000_000,
    cache_create_1h:
      (Number(usage.cache_create_1h_tokens || 0) * rates.cache_create_1h) / 1_000_000,
  };
  const total = Object.values(bd).reduce((a, b) => a + b, 0);
  return { usd: round(total, 6), estimated, breakdown: bd };
}

function round(v, digits) {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

export function getPlan(dbPath, fallback = 'api') {
  return withDb(dbPath, (db) => {
    const row = db.prepare("SELECT v FROM plan WHERE k='plan'").get();
    return row ? row.v : fallback;
  });
}

export function setPlan(dbPath, plan) {
  withDb(dbPath, (db) => {
    db.prepare("INSERT OR REPLACE INTO plan (k, v) VALUES ('plan', ?)").run(plan);
  });
}

export function formatForUser(apiCostUsd, plan, pricing) {
  const p = pricing.plans[plan] || pricing.plans.api;
  if (plan === 'api' || p.monthly === 0) {
    return { display_usd: apiCostUsd, subtitle: null, subscription_usd: null };
  }
  return {
    display_usd: apiCostUsd,
    subtitle: `You pay $${p.monthly}/mo on ${p.label}`,
    subscription_usd: p.monthly,
  };
}
