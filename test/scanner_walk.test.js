import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { initDb } from '../src/db.js';
import { scanDir } from '../src/scanner.js';
import { makeTmpDir, cleanup } from './_helpers.js';

const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

let tmp, dbPath, projRoot, projDir;

beforeEach(() => {
  tmp = makeTmpDir();
  dbPath = path.join(tmp, 't.db');
  projRoot = path.join(tmp, 'projects');
  projDir = path.join(projRoot, 'C--work-sample');
  fs.mkdirSync(projDir, { recursive: true });
  fs.copyFileSync(path.join(FIXTURE_DIR, 'sample_session.jsonl'), path.join(projDir, 's1.jsonl'));
  initDb(dbPath);
});

afterEach(() => cleanup(tmp));

test('scan writes messages and tools', () => {
  const n = scanDir(projRoot, dbPath);
  assert.equal(n.messages, 3);
  assert.equal(n.tools, 2);
  const db = new DatabaseSync(dbPath);
  const row = db.prepare("SELECT project_slug FROM messages WHERE uuid='u1'").get();
  db.close();
  assert.equal(row.project_slug, 'C--work-sample');
});

test('rescan skips unchanged files', () => {
  const n1 = scanDir(projRoot, dbPath);
  const n2 = scanDir(projRoot, dbPath);
  assert.equal(n1.messages, 3);
  assert.equal(n2.messages, 0);
});

test('rescan picks up appended lines', () => {
  scanDir(projRoot, dbPath);
  const file = path.join(projDir, 's1.jsonl');
  fs.appendFileSync(
    file,
    '{"type":"assistant","uuid":"a2","sessionId":"s1","timestamp":"2026-04-10T00:00:03Z","isSidechain":false,"message":{"model":"claude-haiku-4-5","usage":{"input_tokens":1,"output_tokens":1}}}\n'
  );
  // Bump mtime — copyFileSync + appendFileSync on Windows can leave the same
  // 1s-resolution mtime as the prior scan, so force-set a future time.
  const future = Date.now() / 1000 + 5;
  fs.utimesSync(file, future, future);
  const n2 = scanDir(projRoot, dbPath);
  assert.equal(n2.messages, 1);
});
