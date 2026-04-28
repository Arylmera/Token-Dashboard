import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { initDb } from '../src/db.js';
import {
  cacheDisciplineTips, repeatedTargetTips, rightSizeTips, outlierTips,
  allTips, dismissTip,
} from '../src/tips.js';
import { makeTmpDir, cleanup } from './_helpers.js';

let tmp, dbPath;
beforeEach(() => {
  tmp = makeTmpDir();
  dbPath = path.join(tmp, 't.db');
  initDb(dbPath);
});
afterEach(() => cleanup(tmp));

function exec(sql) {
  const db = new DatabaseSync(dbPath);
  db.exec(sql);
  db.close();
}

function ins(ts, project, cacheRead, cacheCreate) {
  const db = new DatabaseSync(dbPath);
  db.prepare(
    `INSERT INTO messages (uuid, session_id, project_slug, type, timestamp,
      model, input_tokens, output_tokens, cache_read_tokens,
      cache_create_5m_tokens, cache_create_1h_tokens) VALUES
      (?, 's', ?, 'assistant', ?, 'claude-opus-4-7', 100, 100, ?, ?, 0)`
  ).run(`uuid-${ts}`, project, ts, cacheRead, cacheCreate);
  db.close();
}

test('cache: low cache hit emits tip', () => {
  ins('2026-04-15T00:00:00Z', 'projX', 10, 1_000_000);
  const tips = cacheDisciplineTips(dbPath, '2026-04-19T00:00:00');
  assert.ok(tips.some((t) => t.category === 'cache'));
  for (const t of tips.filter((t) => t.category === 'cache')) {
    assert.equal(t.project_slug, 'projX');
  }
});

test('cache: healthy cache no tip', () => {
  for (let i = 0; i < 10; i++) ins(`2026-04-15T00:00:0${i}Z`, 'projY', 1_000_000, 50);
  const tips = cacheDisciplineTips(dbPath, '2026-04-19T00:00:00');
  assert.ok(!tips.some((t) => t.category === 'cache'));
});

test('repeat: file & bash emit tips', () => {
  exec(
    "INSERT INTO messages (uuid, session_id, project_slug, type, timestamp, model) VALUES ('m1','s1','p','assistant','2026-04-15T00:00:00Z','claude-opus-4-7')"
  );
  const db = new DatabaseSync(dbPath);
  const tcStmt = db.prepare(
    "INSERT INTO tool_calls (message_uuid, session_id, project_slug, tool_name, target, timestamp, is_error) VALUES ('m1','s1','p',?,?,'2026-04-15T00:00:00Z',0)"
  );
  for (let i = 0; i < 15; i++) tcStmt.run('Read', 'src/Root.tsx');
  for (let i = 0; i < 20; i++) tcStmt.run('Bash', 'npm run lint');
  db.close();

  const tips = repeatedTargetTips(dbPath, '2026-04-19T00:00:00');
  const cats = tips.map((t) => t.category);
  assert.ok(cats.includes('repeat-file'));
  assert.ok(cats.includes('repeat-bash'));
  for (const t of tips) assert.equal(t.project_slug, 'p');
});

test('right-size: short opus turns flagged', () => {
  const db = new DatabaseSync(dbPath);
  const stmt = db.prepare(
    "INSERT INTO messages (uuid, session_id, project_slug, type, timestamp, model, input_tokens, output_tokens, cache_read_tokens, cache_create_5m_tokens, cache_create_1h_tokens, is_sidechain) VALUES (?, 's','p','assistant','2026-04-18T00:00:00Z','claude-opus-4-7', 1000000, 200, 0, 0, 0, 0)"
  );
  for (let i = 0; i < 10; i++) stmt.run(`a${i}`);
  db.close();

  const tips = rightSizeTips(dbPath, '2026-04-19T00:00:00');
  assert.ok(tips.some((t) => t.category === 'right-size'));
  for (const t of tips) assert.equal(t.project_slug, null);
});

test('outlier: giant tool result flagged', () => {
  const db = new DatabaseSync(dbPath);
  const m = db.prepare(
    "INSERT INTO messages (uuid, session_id, project_slug, type, timestamp) VALUES (?, 's','p','user','2026-04-18T00:00:00Z')"
  );
  const t = db.prepare(
    "INSERT INTO tool_calls (message_uuid, session_id, project_slug, tool_name, target, result_tokens, timestamp, is_error) VALUES (?, 's','p','_tool_result','tu',100000,'2026-04-18T00:00:00Z',0)"
  );
  for (let i = 0; i < 20; i++) {
    m.run(`u${i}`);
    t.run(`u${i}`);
  }
  db.close();

  const tips = outlierTips(dbPath, '2026-04-19T00:00:00');
  assert.ok(tips.some((t) => t.category === 'tool-bloat'));
  for (const t of tips) assert.equal(t.project_slug, null);
});

test('project tips get most-recent cwd; global tips have null cwd', () => {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    INSERT INTO messages (uuid, session_id, project_slug, cwd, type, timestamp,
      model, input_tokens, output_tokens, cache_read_tokens,
      cache_create_5m_tokens, cache_create_1h_tokens) VALUES
      ('m1','s','projA','/Users/me/projA','assistant','2026-04-15T00:00:00Z',
       'claude-opus-4-7', 100, 100, 10, 1000000, 0),
      ('m2','s','projA','/Users/me/projA-renamed','assistant','2026-04-18T00:00:00Z',
       'claude-opus-4-7', 100, 100, 10, 1000000, 0);
  `);
  const stmt = db.prepare(
    "INSERT INTO messages (uuid, session_id, project_slug, type, timestamp, model, input_tokens, output_tokens, cache_read_tokens, cache_create_5m_tokens, cache_create_1h_tokens, is_sidechain) VALUES (?, 's','projA','assistant','2026-04-18T00:00:00Z','claude-opus-4-7', 1000000, 200, 0, 0, 0, 0)"
  );
  for (let i = 0; i < 10; i++) stmt.run(`sa${i}`);
  db.close();

  const tips = allTips(dbPath, '2026-04-19T00:00:00');
  const projTips = tips.filter((t) => t.project_slug === 'projA');
  assert.ok(projTips.length);
  for (const t of projTips) assert.equal(t.project_cwd, '/Users/me/projA-renamed');

  const globalTips = tips.filter((t) => t.project_slug === null);
  assert.ok(globalTips.length);
  for (const t of globalTips) assert.equal(t.project_cwd, null);
});

test('dismissed tip does not reappear', () => {
  exec(
    "INSERT INTO messages (uuid, session_id, project_slug, type, timestamp, model, input_tokens, output_tokens, cache_read_tokens, cache_create_5m_tokens, cache_create_1h_tokens) VALUES ('m','s','projZ','assistant','2026-04-15T00:00:00Z','claude-opus-4-7', 100, 100, 10, 1000000, 0)"
  );
  const before = cacheDisciplineTips(dbPath, '2026-04-19T00:00:00');
  assert.ok(before.length);
  dismissTip(dbPath, before[0].key);
  const after = cacheDisciplineTips(dbPath, '2026-04-19T00:00:00');
  assert.equal(after.length, 0);
});
