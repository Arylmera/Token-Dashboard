/** Build forward + backward adjacency from the Rust `vault_links` output. Pure. */
export function buildLinkMaps(notes) {
  const forward = new Map();
  const backward = new Map();
  for (const { rel, links } of notes) {
    forward.set(rel, links);
    for (const target of links) {
      const srcs = backward.get(target) ?? [];
      if (!srcs.includes(rel)) srcs.push(rel);
      backward.set(target, srcs);
    }
  }
  return { forward, backward };
}
