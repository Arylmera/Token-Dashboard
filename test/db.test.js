import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { initDb, connect } from '../src/db.js';
import { makeTmpDir, cleanup } from './_helpers.js';

let tmp;
let dbPath;

beforeEach(() => {
  tmp = makeTmpDir();
  dbPath = path.join(tmp, 'test.db');
});

afterEach(() => {
  cleanup(tmp);
});

test('init creates expected tables', () => {
  initDb(dbPath);
  const db = new DatabaseSync(dbPath);
  const tables = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name)
  );
  db.close();
  for (const t of ['files', 'messages', 'tool_calls', 'plan', 'dismissed_tips']) {
    assert.ok(tables.has(t), `missing table ${t}`);
  }
});

test('init is idempotent', () => {
  initDb(dbPath);
  initDb(dbPath);
});

test('connect returns rows as objects', () => {
  initDb(dbPath);
  const db = connect(dbPath);
  const row = db.prepare('SELECT 1 AS one').get();
  db.close();
  assert.equal(row.one, 1);
});

test('migration adds message_id and clears legacy data', () => {
  // Build a pre-migration schema (full shape minus message_id), with one row.
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE messages (
      uuid TEXT PRIMARY KEY,
      parent_uuid TEXT,
      session_id TEXT NOT NULL,
      project_slug TEXT NOT NULL,
      cwd TEXT,
      git_branch TEXT,
      cc_version TEXT,
      entrypoint TEXT,
      type TEXT NOT NULL,
      is_sidechain INTEGER NOT NULL DEFAULT 0,
      agent_id TEXT,
      timestamp TEXT NOT NULL,
      model TEXT,
      stop_reason TEXT,
      prompt_id TEXT,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_create_5m_tokens INTEGER NOT NULL DEFAULT 0,
      cache_create_1h_tokens INTEGER NOT NULL DEFAULT 0,
      prompt_text TEXT,
      prompt_chars INTEGER,
      tool_calls_json TEXT
    );
    CREATE TABLE tool_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_uuid TEXT NOT NULL,
      session_id TEXT NOT NULL,
      project_slug TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      target TEXT,
      result_tokens INTEGER,
      is_error INTEGER NOT NULL DEFAULT 0,
      timestamp TEXT NOT NULL
    );
    CREATE TABLE files (
      path TEXT PRIMARY KEY,
      mtime REAL NOT NULL,
      bytes_read INTEGER NOT NULL,
      scanned_at REAL NOT NULL
    );
    INSERT INTO messages (uuid, session_id, project_slug, type, timestamp)
    VALUES ('u1', 's1', 'p', 'user', '2026-01-01T00:00:00Z');
  `);
  db.close();

  initDb(dbPath);

  const after = new DatabaseSync(dbPath);
  const cols = after.prepare('PRAGMA table_info(messages)').all().map((r) => r.name);
  assert.ok(cols.includes('message_id'));
  const remaining = after.prepare('SELECT COUNT(*) AS n FROM messages').get();
  after.close();
  assert.equal(Number(remaining.n), 0);
});
