import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export { defaultDbPath } from './paths.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS files (
  path        TEXT PRIMARY KEY,
  mtime       REAL    NOT NULL,
  bytes_read  INTEGER NOT NULL,
  scanned_at  REAL    NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  uuid                    TEXT PRIMARY KEY,
  parent_uuid             TEXT,
  session_id              TEXT NOT NULL,
  project_slug            TEXT NOT NULL,
  cwd                     TEXT,
  git_branch              TEXT,
  cc_version              TEXT,
  entrypoint              TEXT,
  type                    TEXT NOT NULL,
  is_sidechain            INTEGER NOT NULL DEFAULT 0,
  agent_id                TEXT,
  timestamp               TEXT NOT NULL,
  model                   TEXT,
  stop_reason             TEXT,
  prompt_id               TEXT,
  message_id              TEXT,
  input_tokens            INTEGER NOT NULL DEFAULT 0,
  output_tokens           INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens       INTEGER NOT NULL DEFAULT 0,
  cache_create_5m_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_create_1h_tokens  INTEGER NOT NULL DEFAULT 0,
  prompt_text             TEXT,
  prompt_chars            INTEGER,
  tool_calls_json         TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_session   ON messages(session_id);
CREATE INDEX IF NOT EXISTS idx_messages_project   ON messages(project_slug);
CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
CREATE INDEX IF NOT EXISTS idx_messages_model     ON messages(model);
CREATE INDEX IF NOT EXISTS idx_messages_msgid     ON messages(session_id, message_id);

CREATE TABLE IF NOT EXISTS tool_calls (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  message_uuid  TEXT    NOT NULL,
  session_id    TEXT    NOT NULL,
  project_slug  TEXT    NOT NULL,
  tool_name     TEXT    NOT NULL,
  target        TEXT,
  result_tokens INTEGER,
  is_error      INTEGER NOT NULL DEFAULT 0,
  timestamp     TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tools_session ON tool_calls(session_id);
CREATE INDEX IF NOT EXISTS idx_tools_name    ON tool_calls(tool_name);
CREATE INDEX IF NOT EXISTS idx_tools_target  ON tool_calls(target);

CREATE TABLE IF NOT EXISTS plan (
  k TEXT PRIMARY KEY,
  v TEXT
);

CREATE TABLE IF NOT EXISTS dismissed_tips (
  tip_key       TEXT PRIMARY KEY,
  dismissed_at  REAL NOT NULL
);
`;

export function initDb(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    migrateAddMessageId(db);
    db.exec(SCHEMA);
  } finally {
    db.close();
  }
}

export function migrateAddMessageId(db) {
  const hasTable = db
    .prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='messages'")
    .get();
  if (!hasTable) return;
  const cols = db.prepare('PRAGMA table_info(messages)').all().map((r) => r.name);
  if (cols.includes('message_id')) return;
  db.exec(
    'ALTER TABLE messages ADD COLUMN message_id TEXT;' +
      'DELETE FROM messages;' +
      'DELETE FROM tool_calls;' +
      'DELETE FROM files;'
  );
}

export function connect(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}

export function withDb(dbPath, fn) {
  const db = connect(dbPath);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function rangeClause(since, until, col = 'timestamp') {
  const where = [];
  const args = [];
  if (since) {
    where.push(`${col} >= ?`);
    args.push(since);
  }
  if (until) {
    where.push(`${col} < ?`);
    args.push(until);
  }
  return [where.length ? ' AND ' + where.join(' AND ') : '', args];
}

function encodeSlug(p) {
  return (p || '').replace(/[:\\/ ]/g, '-');
}

function walkToRoot(cwd, slug) {
  if (!cwd || !slug) return null;
  const trimmed = cwd.replace(/[/\\]+$/, '');
  const sep = trimmed.includes('\\') ? '\\' : '/';
  const parts = trimmed.split(sep);
  for (let i = parts.length; i > 0; i--) {
    if (encodeSlug(parts.slice(0, i).join(sep)) === slug) {
      const name = parts[i - 1];
      if (name) return name;
    }
  }
  return null;
}

export function projectNameFor(cwd, fallbackSlug) {
  const name = walkToRoot(cwd || '', fallbackSlug || '');
  if (name) return name;
  if (cwd) {
    const trimmed = cwd.replace(/[/\\]+$/, '');
    const sep = trimmed.includes('\\') ? '\\' : '/';
    const tail = trimmed.split(sep).at(-1);
    if (tail) return tail;
  }
  if (fallbackSlug) {
    const parts = fallbackSlug.split(/-+/).filter(Boolean);
    if (parts.length) return parts.at(-1);
  }
  return fallbackSlug || '';
}

export function bestProjectName(cwds, slug) {
  const list = (cwds || []).filter(Boolean);
  for (const cwd of list) {
    const name = walkToRoot(cwd, slug);
    if (name) return name;
  }
  return projectNameFor(list[0] || null, slug);
}

export function overviewTotals(dbPath, since = null, until = null) {
  const [rng, args] = rangeClause(since, until);
  const sql = `
    SELECT COUNT(DISTINCT session_id) AS sessions,
           SUM(CASE WHEN type='user' THEN 1 ELSE 0 END) AS turns,
           COALESCE(SUM(input_tokens),0)            AS input_tokens,
           COALESCE(SUM(output_tokens),0)           AS output_tokens,
           COALESCE(SUM(cache_read_tokens),0)       AS cache_read_tokens,
           COALESCE(SUM(cache_create_5m_tokens),0)  AS cache_create_5m_tokens,
           COALESCE(SUM(cache_create_1h_tokens),0)  AS cache_create_1h_tokens
      FROM messages WHERE 1=1 ${rng}
  `;
  return withDb(dbPath, (db) => normalizeRow(db.prepare(sql).get(...args)));
}

export function expensivePrompts(dbPath, { limit = 50, sort = 'tokens' } = {}) {
  const order = sort === 'recent' ? 'u.timestamp DESC' : 'billable_tokens DESC';
  const sql = `
    SELECT u.uuid AS user_uuid, u.session_id, u.project_slug, u.timestamp,
           u.prompt_text, u.prompt_chars,
           a.uuid AS assistant_uuid, a.model,
           COALESCE(a.input_tokens,0)+COALESCE(a.output_tokens,0)
             +COALESCE(a.cache_create_5m_tokens,0)+COALESCE(a.cache_create_1h_tokens,0) AS billable_tokens,
           COALESCE(a.cache_read_tokens,0) AS cache_read_tokens
      FROM messages u
      JOIN messages a ON a.parent_uuid = u.uuid AND a.type='assistant'
     WHERE u.type='user' AND u.prompt_text IS NOT NULL
     ORDER BY ${order}
     LIMIT ?
  `;
  return withDb(dbPath, (db) => db.prepare(sql).all(limit).map(normalizeRow));
}

export function projectSummary(dbPath, since = null, until = null) {
  const [rng, args] = rangeClause(since, until);
  const sql = `
    SELECT project_slug,
           COUNT(DISTINCT session_id) AS sessions,
           SUM(CASE WHEN type='user' THEN 1 ELSE 0 END) AS turns,
           COALESCE(SUM(input_tokens), 0)  AS input_tokens,
           COALESCE(SUM(output_tokens), 0) AS output_tokens,
           SUM(input_tokens)+SUM(output_tokens)
             +SUM(cache_create_5m_tokens)+SUM(cache_create_1h_tokens) AS billable_tokens,
           SUM(cache_read_tokens) AS cache_read_tokens
      FROM messages m
     WHERE 1=1 ${rng}
     GROUP BY project_slug
     ORDER BY billable_tokens DESC
  `;
  return withDb(dbPath, (db) => {
    const rows = db.prepare(sql).all(...args).map(normalizeRow);
    const cwdStmt = db.prepare(
      'SELECT DISTINCT cwd FROM messages WHERE project_slug=? AND cwd IS NOT NULL'
    );
    for (const r of rows) {
      const cwds = cwdStmt.all(r.project_slug).map((row) => row.cwd);
      r.project_name = bestProjectName(cwds, r.project_slug);
    }
    return rows;
  });
}

export function toolTokenBreakdown(dbPath, since = null, until = null) {
  const [rng, args] = rangeClause(since, until);
  const sql = `
    SELECT tool_name,
           COUNT(*) AS calls,
           COALESCE(SUM(result_tokens),0) AS result_tokens
      FROM tool_calls
     WHERE tool_name != '_tool_result' ${rng}
     GROUP BY tool_name
     ORDER BY calls DESC
  `;
  return withDb(dbPath, (db) => db.prepare(sql).all(...args).map(normalizeRow));
}

export function recentSessions(dbPath, { limit = 20, since = null, until = null } = {}) {
  const [rng, args] = rangeClause(since, until);
  const sql = `
    SELECT session_id, project_slug,
           MIN(timestamp) AS started, MAX(timestamp) AS ended,
           SUM(CASE WHEN type='user' THEN 1 ELSE 0 END) AS turns,
           SUM(input_tokens)+SUM(output_tokens) AS tokens
      FROM messages m
     WHERE 1=1 ${rng}
     GROUP BY session_id
     ORDER BY ended DESC
     LIMIT ?
  `;
  return withDb(dbPath, (db) => {
    const rows = db.prepare(sql).all(...args, limit).map(normalizeRow);
    const slugCache = new Map();
    const cwdStmt = db.prepare(
      'SELECT DISTINCT cwd FROM messages WHERE project_slug=? AND cwd IS NOT NULL'
    );
    for (const r of rows) {
      const slug = r.project_slug;
      if (!slugCache.has(slug)) {
        const cwds = cwdStmt.all(slug).map((row) => row.cwd);
        slugCache.set(slug, bestProjectName(cwds, slug));
      }
      r.project_name = slugCache.get(slug);
    }
    return rows;
  });
}

export function sessionTurns(dbPath, sessionId) {
  const sql = `
    SELECT uuid, parent_uuid, type, timestamp, model, is_sidechain, agent_id,
           input_tokens, output_tokens, cache_read_tokens,
           cache_create_5m_tokens, cache_create_1h_tokens,
           prompt_text, prompt_chars, tool_calls_json, project_slug, cwd
      FROM messages
     WHERE session_id = ?
     ORDER BY timestamp ASC
  `;
  return withDb(dbPath, (db) => db.prepare(sql).all(sessionId).map(normalizeRow));
}

export function dailyTokenBreakdown(dbPath, since = null, until = null) {
  const [rng, args] = rangeClause(since, until);
  const sql = `
    SELECT substr(timestamp, 1, 10) AS day,
           COALESCE(SUM(input_tokens),0)      AS input_tokens,
           COALESCE(SUM(output_tokens),0)     AS output_tokens,
           COALESCE(SUM(cache_read_tokens),0) AS cache_read_tokens,
           COALESCE(SUM(cache_create_5m_tokens),0)
             + COALESCE(SUM(cache_create_1h_tokens),0) AS cache_create_tokens
      FROM messages
     WHERE timestamp IS NOT NULL ${rng}
     GROUP BY day
     ORDER BY day ASC
  `;
  return withDb(dbPath, (db) => db.prepare(sql).all(...args).map(normalizeRow));
}

export function skillBreakdown(dbPath, since = null, until = null) {
  const [rng, args] = rangeClause(since, until);
  const sql = `
    SELECT target AS skill,
           COUNT(*) AS invocations,
           COUNT(DISTINCT session_id) AS sessions,
           MAX(timestamp) AS last_used
      FROM tool_calls
     WHERE tool_name = 'Skill' AND target IS NOT NULL AND target != '' ${rng}
     GROUP BY target
     ORDER BY invocations DESC
  `;
  return withDb(dbPath, (db) => db.prepare(sql).all(...args).map(normalizeRow));
}

export function modelBreakdown(dbPath, since = null, until = null) {
  const [rng, args] = rangeClause(since, until);
  const sql = `
    SELECT COALESCE(model, 'unknown') AS model,
           COUNT(*) AS turns,
           COALESCE(SUM(input_tokens),0)            AS input_tokens,
           COALESCE(SUM(output_tokens),0)           AS output_tokens,
           COALESCE(SUM(cache_read_tokens),0)       AS cache_read_tokens,
           COALESCE(SUM(cache_create_5m_tokens),0)  AS cache_create_5m_tokens,
           COALESCE(SUM(cache_create_1h_tokens),0)  AS cache_create_1h_tokens
      FROM messages
     WHERE type = 'assistant' ${rng}
     GROUP BY model
     ORDER BY (input_tokens + output_tokens + cache_create_5m_tokens + cache_create_1h_tokens) DESC
  `;
  return withDb(dbPath, (db) => db.prepare(sql).all(...args).map(normalizeRow));
}

// node:sqlite returns BigInt for INTEGER columns when values exceed 2^31. Coerce
// to Number so JSON.stringify and arithmetic match the Python output exactly.
function normalizeRow(row) {
  if (!row) return row;
  for (const k of Object.keys(row)) {
    const v = row[k];
    if (typeof v === 'bigint') {
      row[k] = Number.isSafeInteger(Number(v)) ? Number(v) : v.toString();
    }
  }
  return row;
}
