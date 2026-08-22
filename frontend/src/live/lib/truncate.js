// The Live console is a tail view, not an archive: the full transcript stays on
// disk in ~/.claude/projects/**/*.jsonl. Turns carrying tool results or file
// dumps reach hundreds of KB, and the 500-line-per-session cap bounds the line
// COUNT but not the byte size, so retained memory is bounded here instead.
export const MAX_TURN_CHARS = 2000;

export function truncateText(text) {
  if (typeof text !== "string") return text;
  if (text.length <= MAX_TURN_CHARS) return text;
  const dropped = text.length - MAX_TURN_CHARS;
  return `${text.slice(0, MAX_TURN_CHARS)}\n… [${dropped} chars truncated]`;
}
