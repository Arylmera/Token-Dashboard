"use strict";

// Single source of truth for compact display formatting used by both the
// Electron main process (tray title, taskbar overlay, dock badge) and any
// future client. Frontend can `await import` this file when it gets a real
// bundler; for now it duplicates the logic locally.

function formatTokens(n) {
  if (n == null || Number.isNaN(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return strip(n / 1_000_000) + "M";
  if (abs >= 1_000) return strip(n / 1_000) + "k";
  return String(Math.round(n));
}

function formatCostUSD(usd) {
  if (usd == null || Number.isNaN(usd)) return "—";
  if (usd >= 100) return `$${Math.round(usd)}`;
  if (usd >= 10) return `$${usd.toFixed(1)}`;
  return `$${usd.toFixed(2)}`;
}

function strip(v) {
  return v.toFixed(1).replace(/\.0$/, "");
}

module.exports = { formatTokens, formatCostUSD };
