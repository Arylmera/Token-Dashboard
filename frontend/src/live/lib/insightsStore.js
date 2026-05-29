/** A single tool call observed in a live session, paired from toolActivity→toolDone. */

/** Per-session ordered tool-call list. */

/** Mirror the transcript's 500-line cap to bound memory. */
export const MAX_CALLS_PER_SESSION = 500;

export function emptyInsights() {
  return new Map();
}

/** Pure: fold one WatchEvent into a NEW insights state.
 *  `nowMs` is the frontend arrival timestamp (Date.now() at the call site). */
export function reduceInsights(prev, e, nowMs) {
  if (e.type !== "session") return prev;
  const { sessionId, agentRef, event } = e.data;
  if (event.kind !== "toolActivity" && event.kind !== "toolDone") return prev;

  const next = new Map(prev);
  const calls = [...(next.get(sessionId) ?? [])];

  if (event.kind === "toolActivity") {
    calls.push({
      id: event.data.toolUseId,
      name: event.data.name,
      filePath: event.data.filePath,
      agentRef,
      startMs: nowMs,
      status: "running",
    });
    if (calls.length > MAX_CALLS_PER_SESSION) calls.splice(0, calls.length - MAX_CALLS_PER_SESSION);
    next.set(sessionId, calls);
    return next;
  }

  // toolDone: pair by toolUseId (last matching open/closed call wins).
  const idx = lastIndexOf(calls, event.data.toolUseId);
  if (idx === -1) return prev; // orphan toolDone — ignore
  calls[idx] = { ...calls[idx], endMs: nowMs, status: event.data.isError ? "error" : "ok", errorText: event.data.isError ? event.data.error ?? null : null };
  next.set(sessionId, calls);
  return next;
}

function lastIndexOf(calls, id) {
  for (let i = calls.length - 1; i >= 0; i--) if (calls[i].id === id) return i;
  return -1;
}

/** Failure count for a session: errored tool calls plus an optional run error. */
export function failures(state, sessionId, opts) {
  const calls = state.get(sessionId) ?? [];
  const errs = calls.reduce((n, c) => n + (c.status === "error" ? 1 : 0), 0);
  return errs + (opts?.runError ? 1 : 0);
}
