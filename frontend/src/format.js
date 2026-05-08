// Display formatters used by the React UI. Distinct from shared/format.js,
// which serves the Electron tray with its own compact rules.

export const fmtCost = (n) => `$${(n || 0).toFixed(2)}`;

export const fmtNum = (n) => (n || 0).toLocaleString("en-US");

export const fmtTokens = (n) => {
  n = n || 0;
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return n.toString();
};

export const fmtPct = (n) => ((n || 0) * 100).toFixed(1) + "%";
