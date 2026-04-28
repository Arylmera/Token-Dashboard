import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { initDb } from '../src/db.js';
import { scanDir } from '../src/scanner.js';
import { makeTmpDir, cleanup } from './_helpers.js';

let tmp, dbPath, projRoot, projDir;

beforeEach(() => {
  tmp = makeTmpDir();
  dbPath = path.join(tmp, 't.db');
  projRoot = path.join(tmp, 'projects');
  projDir = path.join(projRoot, 'C--work-sample');
  fs.mkdirSync(projDir, { recursive: true });
  initDb(dbPath);
});

afterEach(() => cleanup(tmp));

const jsonlPath = () => path.join(projDir, 's1.jsonl');

function userRecord() {
  return {
    type: 'user', uuid: 'u1', sessionId: 's1',
    timestamp: '2026-04-10T00:00:00Z', isSidechain: false,
    message: { role: 'user', content: 'hi' },
  };
}

function assistantWithToolUse(uuid, msgId, ts, outputTokens) {
  return {
    type: 'assistant', uuid, parentUuid: 'u1', sessionId: 's1',
    timestamp: ts, isSidechain: false,
    message: {
      id: msgId, model: 'claude-opus-4-7',
      content: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: 'foo.py' } }],
      usage: { input_tokens: 10, output_tokens: outputTokens },
    },
  };
}

function writeJsonl(p, lines) {
  fs.writeFileSync(p, lines.map((o) => JSON.stringify(o)).join('\n') + '\n');
}

function countTools() {
  const db = new DatabaseSync(dbPath);
  const r = db.prepare("SELECT COUNT(*) AS n FROM tool_calls WHERE tool_name='Read'").get();
  db.close();
  return Number(r.n);
}

test('partial line at EOF is not skipped on next scan', () => {
  const recA = assistantWithToolUse('a1', 'msg_A', '2026-04-10T00:00:01Z', 10);
  const partialBStr = JSON.stringify(assistantWithToolUse('a2', 'msg_B', '2026-04-10T00:00:02Z', 20));
  const half = Math.floor(partialBStr.length / 2);

  fs.writeFileSync(
    jsonlPath(),
    JSON.stringify(userRecord()) + '\n' + JSON.stringify(recA) + '\n' + partialBStr.slice(0, half)
  );

  scanDir(projRoot, dbPath);

  let db = new DatabaseSync(dbPath);
  const after1 = db.prepare('SELECT uuid FROM messages').all().map((r) => r.uuid).sort();
  db.close();
  assert.deepEqual(after1, ['a1', 'u1']);

  const recC = assistantWithToolUse('a3', 'msg_C', '2026-04-10T00:00:03Z', 30);
  fs.appendFileSync(jsonlPath(), partialBStr.slice(half) + '\n' + JSON.stringify(recC) + '\n');
  const future = Date.now() / 1000 + 10;
  fs.utimesSync(jsonlPath(), future, future);

  scanDir(projRoot, dbPath);

  db = new DatabaseSync(dbPath);
  const after2 = db.prepare('SELECT uuid FROM messages').all().map((r) => r.uuid).sort();
  db.close();
  assert.deepEqual(after2, ['a1', 'a2', 'a3', 'u1']);
});

test('rescan with same content does not duplicate tool_calls', () => {
  writeJsonl(jsonlPath(), [
    userRecord(),
    assistantWithToolUse('a1', 'msg_X', '2026-04-10T00:00:01Z', 42),
  ]);

  scanDir(projRoot, dbPath);
  assert.equal(countTools(), 1);

  const future = Date.now() / 1000 + 10;
  fs.utimesSync(jsonlPath(), future, future);

  scanDir(projRoot, dbPath);
  assert.equal(countTools(), 1);
});
