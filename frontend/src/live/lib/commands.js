/* The navigable views, in the same order the ViewSwitcher renders them. */
const NAV_VIEWS = ["console", "cockpit", "explorer"];

/* Dependencies are injectable so buildCommands stays unit-testable without
   touching the live stores. In browser/Tauri context, import the real stores
   and pass them in; in tests, always inject all deps explicitly. */
export function buildCommands(deps = {}) {
  // No top-level store imports — callers must inject deps in non-browser env.
  const sessions = deps.sessions ?? (() => new Map());
  const metas = deps.metas ?? (() => new Map());
  const themedCopy = deps.themedCopy ?? (() => undefined);
  const navTo = deps.setView ?? (() => {});
  const activate = deps.setActiveId ?? (() => {});


  const nav = NAV_VIEWS.map((v) => ({
    id: `nav:${v}`,
    title: themedCopy()?.nav[v] ?? v,
    group: "Navigate",
    run: () => navTo(v),
  }));

  const session = [...sessions().keys()].map((id) => {
    const meta = metas().get(id);
    const project = sessions().get(id)?.project ?? meta?.project;
    return {
      id: `session:${id}`,
      title: meta?.title ?? project ?? id.slice(0, 8),
      group: "Session",
      hint: project,
      run: () => { activate(id); navTo("console"); },
    };
  });

  return [...nav, ...session];
}

/* Pure, case-insensitive substring filter over title (+ hint). Empty query
   returns the list unchanged, preserving group order. */
export function filterCommands(list, query) {
  const q = query.trim().toLowerCase();
  if (!q) return list;
  return list.filter(
    (c) =>
      c.title.toLowerCase().includes(q) ||
      (c.hint?.toLowerCase().includes(q) ?? false),
  );
}
