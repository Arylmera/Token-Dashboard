/** Stable, legible names for nested agents from their refs in first-seen order.
 *  Duplicate subagent types are numbered ("Explore 1"/"Explore 2"); a unique
 *  type is used bare; refs with no type fall back to sequential "agent N". */
export function buildAgentNames(refsInOrder, typeOf) {
  const map = new Map();
  const typeTotals = new Map();
  for (const r of refsInOrder) { const t = typeOf(r); if (t) typeTotals.set(t, (typeTotals.get(t) ?? 0) + 1); }
  const typeSeen = new Map();
  let generic = 0;
  for (const r of refsInOrder) {
    const t = typeOf(r);
    if (t) {
      const n = (typeSeen.get(t) ?? 0) + 1;
      typeSeen.set(t, n);
      map.set(r, (typeTotals.get(t) ?? 1) > 1 ? `${t} ${n}` : t);
    } else {
      map.set(r, `agent ${++generic}`);
    }
  }
  return map;
}
