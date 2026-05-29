import { forceSimulation, forceManyBody, forceLink, forceCenter, forceCollide, forceX, forceY, forceRadial } from "d3-force";
import { stratify, tree } from "d3-hierarchy";

// BFS hop-distance from the root(s). Roots = nodes with no incoming edge (or, if
// the graph is fully cyclic, every node falls back to depth 0). Edges are walked
// undirected so children of a hub all land one ring out regardless of direction.
function bfsDepth(state) {
  const adj = new Map();
  for (const id of state.nodes.keys()) adj.set(id, []);
  const hasIncoming = new Set();
  for (const e of state.edges.values()) {
    adj.get(e.source)?.push(e.target);
    adj.get(e.target)?.push(e.source);
    hasIncoming.add(e.target);
  }
  const depth = new Map();
  const queue = [];
  for (const id of state.nodes.keys()) {
    if (!hasIncoming.has(id)) { depth.set(id, 0); queue.push(id); }
  }
  // Fully cyclic / no clear root: seed BFS from an arbitrary node.
  if (queue.length === 0 && state.nodes.size > 0) {
    const first = state.nodes.keys().next().value;
    depth.set(first, 0); queue.push(first);
  }
  while (queue.length) {
    const cur = queue.shift();
    const d = depth.get(cur);
    for (const next of adj.get(cur) ?? []) {
      if (!depth.has(next)) { depth.set(next, d + 1); queue.push(next); }
    }
  }
  return depth;
}

// Map every node to its root-project group: the topmost project/repo ancestor
// reached by walking incoming edges. Worktrees of one repo share their repo's
// group; unrelated projects each get their own. Used to push distinct project
// roots apart so each sunburst claims its own space instead of piling up center.
function rootGroups(state) {
  const parent = new Map(); // node -> first incoming source
  for (const e of state.edges.values()) {
    if (!parent.has(e.target) && state.nodes.has(e.source)) parent.set(e.target, e.source);
  }
  const find = (id) => {
    let cur = id;
    for (let guard = 0; parent.has(cur) && guard < 1000; guard++) cur = parent.get(cur);
    return cur;
  };
  const group = new Map();
  for (const id of state.nodes.keys()) group.set(id, find(id));
  return group;
}

export class RadialForceLayout {
  get name() { return "radial"; }
  layout(state, width, height) {
    const nodes = [...state.nodes.keys()].map((id) => ({ id }));
    const links = [...state.edges.values()].map((e) => ({ source: e.source, target: e.target }));
    // Graph distance from the root(s) → concentric rings. Parents/children stay
    // radially ordered, which prevents most spoke crossings while charge+collide
    // keep the ring positions jittered (organic, not a rigid dendrogram).
    const depth = bfsDepth(state);
    const ring = Math.min(width, height) / 2 / (Math.max(0, ...depth.values()) + 1);
    const cx = width / 2, cy = height / 2;
    // Extra breathing room between nodes belonging to DIFFERENT project roots, so
    // unrelated projects (a root in another directory) don't crowd each other.
    const group = rootGroups(state);
    const SEP_DIST = 240; // min gap enforced across groups
    const interGroupSeparation = (alpha) => {
      const k = alpha * 0.6;
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i], b = nodes[j];
          if (group.get(a.id) === group.get(b.id)) continue;
          const dx = (b.x ?? 0) - (a.x ?? 0), dy = (b.y ?? 0) - (a.y ?? 0);
          const d = Math.hypot(dx, dy) || 1;
          if (d >= SEP_DIST) continue;
          const push = ((SEP_DIST - d) / d) * k;
          const fx = dx * push, fy = dy * push;
          a.x = (a.x ?? 0) - fx; a.y = (a.y ?? 0) - fy;
          b.x = (b.x ?? 0) + fx; b.y = (b.y ?? 0) + fy;
        }
      }
    };
    const sim = forceSimulation(nodes)
      .force("charge", forceManyBody().strength(-520))
      .force("link", forceLink(links).id((d) => d.id).distance(140))
      .force("center", forceCenter(cx, cy))
      .force("collide", forceCollide(70)) // keep nodes (and their labels) from overlapping
      .force("radial", forceRadial((d) => (depth.get(d.id) ?? 0) * ring, cx, cy).strength(0.45))
      .force("rootSep", interGroupSeparation)
      // Gently pull every node toward the middle so DISCONNECTED components (e.g. an
      // orphan agent cluster) sit close to the rest instead of flying to the corners.
      .force("x", forceX(width / 2).strength(0.08))
      .force("y", forceY(height / 2).strength(0.08))
      .stop();
    // Run a fixed number of ticks for a deterministic-enough static layout.
    for (let i = 0; i < 260; i++) sim.tick();
    return nodes.map((n) => ({ id: n.id, x: n.x ?? width / 2, y: n.y ?? height / 2 }));
  }
}

const HROOT = "__hroot__";

export class HierarchicalLayout {
  get name() { return "hierarchical"; }
  layout(state, width, height) {
    if (state.nodes.size === 0) return [];
    // Parent of each node = source of its first incoming edge; any node with no
    // incoming edge (project roots, the local run, etc.) attaches to a synthetic
    // super-root so stratify always sees exactly ONE root (multi-session safe).
    const edges = [...state.edges.values()];
    const rows = [{ id: HROOT, parentId: null }];
    for (const id of state.nodes.keys()) {
      const incoming = edges.find((e) => e.target === id);
      const parentId = incoming && state.nodes.has(incoming.source) ? incoming.source : HROOT;
      rows.push({ id, parentId });
    }
    let root;
    try {
      root = stratify()
        .id((d) => d.id).parentId((d) => d.parentId)(rows);
    } catch {
      // Cycle or duplicate parent edge — fall back to flat under the root.
      const flat = rows.map((r) => (r.id === HROOT ? r : { id: r.id, parentId: HROOT }));
      root = stratify()
        .id((d) => d.id).parentId((d) => d.parentId)(flat);
    }
    tree().size([height - 40, width - 140])(root);
    return root.descendants()
      .filter((d) => d.data.id !== HROOT)
      .map((d) => ({ id: d.data.id, x: d.y + 70, y: d.x + 20 }));
  }
}
