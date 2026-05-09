// frontend/src/sse-dispatch.js
// Pure function: given the registry, an SSE hint, and the active range's
// since-ISO, return the list of registry keys to refetch.
//
// Hint shape: { sessions, projects, days, models, min_ts, max_ts } (all optional).
// Range since-ISO is the active currentRange's "since" boundary, or null for "all".

export function pickEntries(registry, hint, rangeSince) {
  const out = [];
  const h = hint || {};
  const has = {
    sessions: Array.isArray(h.sessions) && h.sessions.length > 0,
    projects: Array.isArray(h.projects) && h.projects.length > 0,
    models:   Array.isArray(h.models)   && h.models.length   > 0,
    daysMax:  Array.isArray(h.days) && h.days.length > 0
      ? h.days.reduce((a, b) => (a > b ? a : b))
      : null,
  };
  for (const e of registry) {
    if (e.trigger === "static") continue;
    if (e.trigger === "any") { out.push(e.key); continue; }
    if (e.trigger === "sessions" && has.sessions) { out.push(e.key); continue; }
    if (e.trigger === "projects" && has.projects) { out.push(e.key); continue; }
    if (e.trigger === "models"   && has.models)   { out.push(e.key); continue; }
    if (e.trigger === "days") {
      if (!has.daysMax) continue;
      const since = e.windowSince ? e.windowSince(rangeSince) : rangeSince;
      if (since == null) { out.push(e.key); continue; }   // unbounded window
      if (has.daysMax >= since.slice(0, 10)) { out.push(e.key); continue; }
    }
  }
  return out;
}

export function pickStaticEntries(registry) {
  return registry.filter((e) => e.trigger === "static").map((e) => e.key);
}
