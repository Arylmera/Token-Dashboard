import fs from 'node:fs';
import path from 'node:path';

import { connect } from './db.js';

const MSG_COLS = [
  'uuid', 'parent_uuid', 'session_id', 'project_slug', 'cwd', 'git_branch', 'cc_version', 'entrypoint',
  'type', 'is_sidechain', 'agent_id', 'timestamp', 'model', 'stop_reason', 'prompt_id', 'message_id',
  'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_create_5m_tokens', 'cache_create_1h_tokens',
  'prompt_text', 'prompt_chars', 'tool_calls_json',
];

const INSERT_MSG = `
  INSERT OR REPLACE INTO messages (${MSG_COLS.join(', ')})
  VALUES (${MSG_COLS.map(() => '?').join(', ')})
`;

const TOOL_COLS = [
  'message_uuid', 'session_id', 'project_slug', 'tool_name', 'target', 'result_tokens', 'is_error', 'timestamp',
];

const INSERT_TOOL = `
  INSERT INTO tool_calls (${TOOL_COLS.join(', ')})
  VALUES (${TOOL_COLS.map(() => '?').join(', ')})
`;

const TARGET_FIELDS = {
  Read: 'file_path',
  Edit: 'file_path',
  Write: 'file_path',
  Glob: 'pattern',
  Grep: 'pattern',
  Bash: 'command',
  WebFetch: 'url',
  WebSearch: 'query',
  Task: 'subagent_type',
  Skill: 'skill',
};

function asInt(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function extractUsage(rec) {
  const u = (rec.message && rec.message.usage) || {};
  const cc = u.cache_creation || {};
  return {
    input_tokens: asInt(u.input_tokens),
    output_tokens: asInt(u.output_tokens),
    cache_read_tokens: asInt(u.cache_read_input_tokens),
    cache_create_5m_tokens: asInt(cc.ephemeral_5m_input_tokens),
    cache_create_1h_tokens: asInt(cc.ephemeral_1h_input_tokens),
  };
}

function extractPromptText(rec) {
  if (rec.type !== 'user') return [null, null];
  const content = rec.message && rec.message.content;
  if (typeof content === 'string') return [content, content.length];
  if (Array.isArray(content)) {
    const parts = content
      .filter((b) => b && typeof b === 'object' && b.type === 'text')
      .map((b) => b.text || '');
    if (!parts.length) return [null, null];
    const text = parts.join('');
    return [text, text.length];
  }
  return [null, null];
}

function extractTarget(name, input) {
  const field = TARGET_FIELDS[name];
  if (!field || !input || typeof input !== 'object') return null;
  const v = input[field];
  return typeof v === 'string' ? v.slice(0, 500) : null;
}

function extractToolUses(rec) {
  const out = [];
  const content = rec.message && rec.message.content;
  if (!Array.isArray(content)) return out;
  for (const block of content) {
    if (!block || typeof block !== 'object' || block.type !== 'tool_use') continue;
    const name = block.name || 'unknown';
    out.push({
      tool_name: name,
      target: extractTarget(name, block.input || {}),
      result_tokens: null,
      is_error: 0,
      timestamp: rec.timestamp,
    });
  }
  return out;
}

function extractToolResults(rec) {
  const out = [];
  const content = rec.message && rec.message.content;
  if (!Array.isArray(content)) return out;
  for (const block of content) {
    if (!block || typeof block !== 'object' || block.type !== 'tool_result') continue;
    const body = block.content;
    let chars = 0;
    if (typeof body === 'string') chars = body.length;
    else if (Array.isArray(body))
      chars = body.reduce((a, p) => a + (p && typeof p === 'object' ? (p.text || '').length : 0), 0);
    out.push({
      tool_name: '_tool_result',
      target: block.tool_use_id || null,
      result_tokens: Math.floor(chars / 4),
      is_error: block.is_error ? 1 : 0,
      timestamp: rec.timestamp,
    });
  }
  return out;
}

export function parseRecord(rec, projectSlug) {
  const msgObj = rec.message || {};
  const [text, chars] = extractPromptText(rec);
  const usage = extractUsage(rec);
  const msg = {
    uuid: rec.uuid,
    parent_uuid: rec.parentUuid ?? null,
    session_id: rec.sessionId,
    project_slug: projectSlug,
    cwd: rec.cwd ?? null,
    git_branch: rec.gitBranch ?? null,
    cc_version: rec.version ?? null,
    entrypoint: rec.entrypoint ?? null,
    type: rec.type,
    is_sidechain: rec.isSidechain ? 1 : 0,
    agent_id: rec.agentId ?? null,
    timestamp: rec.timestamp,
    model: msgObj.model ?? null,
    stop_reason: msgObj.stop_reason ?? null,
    prompt_id: rec.promptId ?? null,
    message_id: msgObj.id ?? null,
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cache_read_tokens: usage.cache_read_tokens,
    cache_create_5m_tokens: usage.cache_create_5m_tokens,
    cache_create_1h_tokens: usage.cache_create_1h_tokens,
    prompt_text: text,
    prompt_chars: chars,
    tool_calls_json: null,
  };
  const tools = extractToolUses(rec).concat(extractToolResults(rec));
  if (tools.length) {
    msg.tool_calls_json = JSON.stringify(
      tools
        .filter((t) => t.tool_name !== '_tool_result')
        .map((t) => ({ name: t.tool_name, target: t.target }))
    );
  }
  for (const t of tools) {
    t.message_uuid = msg.uuid;
    t.session_id = msg.session_id;
    t.project_slug = projectSlug;
  }
  return [msg, tools];
}

function evictPriorSnapshots(db, sessionId, messageId, keepUuid) {
  const old = db
    .prepare('SELECT uuid FROM messages WHERE session_id=? AND message_id=? AND uuid!=?')
    .all(sessionId, messageId, keepUuid)
    .map((r) => r.uuid);
  if (!old.length) return;
  const placeholders = old.map(() => '?').join(',');
  db.prepare(`DELETE FROM tool_calls WHERE message_uuid IN (${placeholders})`).run(...old);
  db.prepare(`DELETE FROM messages WHERE uuid IN (${placeholders})`).run(...old);
}

function projectSlug(filePath, projectsRoot) {
  const rel = path.relative(projectsRoot, filePath);
  const parts = rel.split(/[/\\]/);
  return parts[0];
}

export function scanFile(filePath, projectSlugStr, db, startByte = 0) {
  const insertMsg = db.prepare(INSERT_MSG);
  const insertTool = db.prepare(INSERT_TOOL);
  const deleteToolsByUuid = db.prepare('DELETE FROM tool_calls WHERE message_uuid=?');

  let totalSize = 0;
  try {
    totalSize = fs.statSync(filePath).size;
  } catch {
    return { messages: 0, tools: 0, end_offset: startByte };
  }
  if (startByte >= totalSize) return { messages: 0, tools: 0, end_offset: startByte };

  const fd = fs.openSync(filePath, 'r');
  const len = totalSize - startByte;
  const buf = Buffer.allocUnsafe(len);
  let read = 0;
  while (read < len) {
    const n = fs.readSync(fd, buf, read, len - read, startByte + read);
    if (n <= 0) break;
    read += n;
  }
  fs.closeSync(fd);

  let messages = 0;
  let tools = 0;
  let endOffset = startByte;
  let pos = 0;
  while (pos < read) {
    const nl = buf.indexOf(0x0a, pos);
    if (nl === -1) break; // partial trailing line — leave for next scan
    const lineEnd = startByte + nl + 1;
    const line = buf.toString('utf8', pos, nl).trim();
    pos = nl + 1;
    if (!line) {
      endOffset = lineEnd;
      continue;
    }
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      endOffset = lineEnd;
      continue;
    }
    if (!rec || typeof rec !== 'object' || !('uuid' in rec) || !('type' in rec)) {
      endOffset = lineEnd;
      continue;
    }
    const [msg, tlist] = parseRecord(rec, projectSlugStr);
    if (!msg.session_id || !msg.timestamp) {
      endOffset = lineEnd;
      continue;
    }
    if (msg.message_id) {
      evictPriorSnapshots(db, msg.session_id, msg.message_id, msg.uuid);
    }
    insertMsg.run(...MSG_COLS.map((k) => msg[k]));
    deleteToolsByUuid.run(msg.uuid);
    for (const t of tlist) {
      insertTool.run(...TOOL_COLS.map((k) => t[k]));
      tools += 1;
    }
    messages += 1;
    endOffset = lineEnd;
  }
  return { messages, tools, end_offset: endOffset };
}

function* walkJsonl(root) {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile() && e.name.endsWith('.jsonl')) yield full;
    }
  }
}

export function scanDir(projectsRoot, dbPath) {
  const totals = { messages: 0, tools: 0, files: 0 };
  let stat;
  try {
    stat = fs.statSync(projectsRoot);
  } catch {
    return totals;
  }
  if (!stat.isDirectory()) return totals;

  const db = connect(dbPath);
  try {
    const fileLookup = db.prepare('SELECT mtime, bytes_read FROM files WHERE path=?');
    const fileUpsert = db.prepare(
      'INSERT OR REPLACE INTO files (path, mtime, bytes_read, scanned_at) VALUES (?, ?, ?, ?)'
    );
    db.exec('BEGIN');
    try {
      for (const p of walkJsonl(projectsRoot)) {
        let st;
        try {
          st = fs.statSync(p);
        } catch {
          continue;
        }
        const mtimeSec = st.mtimeMs / 1000;
        const row = fileLookup.get(p);
        let offset = 0;
        if (row && row.mtime === mtimeSec && Number(row.bytes_read) === st.size) continue;
        if (row && st.size > Number(row.bytes_read)) offset = Number(row.bytes_read);
        const slug = projectSlug(p, projectsRoot);
        const sub = scanFile(p, slug, db, offset);
        fileUpsert.run(p, mtimeSec, sub.end_offset, Date.now() / 1000);
        totals.messages += sub.messages;
        totals.tools += sub.tools;
        totals.files += 1;
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  } finally {
    db.close();
  }
  return totals;
}
