export const stemOf = (rel) => (rel.replace(/\\/g, "/").split("/").pop() ?? rel).replace(/\.md$/i, "");
export const folderOf = (rel) => {
  const p = rel.replace(/\\/g, "/");
  const i = p.indexOf("/");
  return i < 0 ? "root" : p.slice(0, i);
};

/** Build a GraphState from live wikilink adjacency. Node per note (tagged by
 *  folder, weighted by degree), edge per resolved link. Pure. */
export function linksToGraph(notes) {
  const nodes = new Map();
  const edges = new Map();
  const deg = new Map();
  const bump = (id) => deg.set(id, (deg.get(id) ?? 0) + 1);
  const ensure = (rel) => {
    if (!nodes.has(rel)) nodes.set(rel, { id: rel, kind: "folder", label: stemOf(rel), status: "complete", session: folderOf(rel) });
  };
  for (const n of notes) {
    ensure(n.rel);
    for (const t of n.links) {
      ensure(t);
      const id = `${n.rel}->${t}`;
      if (!edges.has(id)) { edges.set(id, { id, source: n.rel, target: t }); bump(n.rel); bump(t); }
    }
  }
  for (const [id, node] of nodes) node.weight = deg.get(id) ?? 0;
  return { nodes, edges, activity: [] };
}
