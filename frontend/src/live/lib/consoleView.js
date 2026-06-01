// Pure view-model helpers for the Console transcript + timeline. No React state
// here, so each function is unit-testable as plain (in) -> (out). The Console
// wraps these in memos over its live stores.

// ---- tool-call chips ------------------------------------------------------
/** A turn's text is prose lines plus tool placeholders ("[Read path]", "[Bash]")
 *  joined by newlines. Splits each line so tool calls render as chips, not prose. */
export function toolSegs(text) {
  return text.split("\n").map((s) => {
    const m = s.match(/^\[(\S+)(?:\s+([\s\S]+?))?\]$/);
    return m ? { tool: true, name: m[1], arg: m[2] ?? "" } : { tool: false, text: s };
  });
}

// ---- master stream flow ---------------------------------------------------
/** Master lines verbatim, with a one-time jump marker at the first appearance of
 *  each subagent (the subagent's own steps live in its swap view). */
export function masterFlow(lines) {
  const out = [];
  const seenSub = new Set();
  for (const l of lines) {
    if (l.agentRef === "master") out.push({ kind: "line", line: l });
    else if (!seenSub.has(l.agentRef)) {
      seenSub.add(l.agentRef);
      out.push({ kind: "marker", ref: l.agentRef });
    }
  }
  return out;
}

// ---- answer highlighting --------------------------------------------------
/** For each user question, the last master assistant line of that round is the
 *  "answer" and stays highlighted; narration before it is muted. The trailing
 *  round's answer is only marked once the run finishes (no mid-flight highlight). */
export function answerLines(lines, running) {
  const master = lines.filter((l) => l.agentRef === "master");
  const set = new Set();
  for (let i = 0; i < master.length; i++) {
    const l = master[i];
    if (l.role === "user") continue;
    const next = master[i + 1];
    if (!next) {
      if (!running) set.add(l);
    } else if (next.role === "user") set.add(l);
  }
  return set;
}

// ---- timeline -------------------------------------------------------------
/** Ordered swimlanes: master first, then each subagent ref in first-seen order. */
export function lanes(calls) {
  const seen = [];
  for (const c of calls) if (!seen.includes(c.agentRef)) seen.push(c.agentRef);
  return seen.sort((a, b) => (a === "master" ? -1 : b === "master" ? 1 : 0));
}

/** Time window relative to the session's first call; min 1s so bars stay visible. */
export function timeSpan(calls, now) {
  if (calls.length === 0) return { t0: 0, ms: 1000 };
  const t0 = Math.min(...calls.map((c) => c.startMs));
  const tEnd = Math.max(...calls.map((c) => c.endMs ?? now));
  return { t0, ms: Math.max(1000, tEnd - t0) };
}

// ---- subagent naming inputs -----------------------------------------------
/** Non-master subagent refs in first-seen order across the transcript then the
 *  tool calls — the order `buildAgentNames` numbers duplicates by. */
export function orderedAgentRefs(lines, calls) {
  const refs = [];
  for (const l of lines) if (l.agentRef !== "master" && !refs.includes(l.agentRef)) refs.push(l.agentRef);
  for (const c of calls) if (c.agentRef !== "master" && !refs.includes(c.agentRef)) refs.push(c.agentRef);
  return refs;
}

/** Subagent refs (first-seen order) and how many transcript lines each produced,
 *  for the collapsed rail rows. */
export function subagentSteps(lines) {
  const refs = [];
  const steps = new Map();
  for (const l of lines) {
    if (l.agentRef !== "master") {
      if (!refs.includes(l.agentRef)) refs.push(l.agentRef);
      steps.set(l.agentRef, (steps.get(l.agentRef) ?? 0) + 1);
    }
  }
  return { refs, steps };
}
