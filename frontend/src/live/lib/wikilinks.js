/** Replace [[Name]] / [[Name|alias]] in rendered HTML with anchors carrying
 *  data-rel when the name resolves against the index, else a dim span.
 *  `index` maps lowercased note name -> vault-relative path. Pure. */
export function resolveWikilinks(html, index) {
  return html.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, name, alias) => {
    const key = name.trim().toLowerCase();
    const label = (alias ?? name).trim();
    const rel = index.get(key);
    if (rel) {
      return `<a href="#" class="wikilink" data-rel="${rel}">${label}</a>`;
    }
    return `<span class="wikilink-unresolved" title="unresolved">${label}</span>`;
  });
}
