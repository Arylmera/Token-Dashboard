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

function writeJsonl(p, lines) {
  fs.writeFileSync(p, lines.map((o) => JSON.stringify(o)).join('\n') + '\n');
}

function streamingPartial(uuid, msgId, session, ts, outputTokens) {
  return {
    type: 'assistant',
    uuid,
    parentUuid: 'u1',
    sessionId: session,
    timestamp: ts,
    isSidechain: false,
    message: {
      id: msgId,
      model: 'claude-opus-4-7',
      content: [{ type: 'text', text: 'streaming...' }],
      usage: {
        input_tokens: 100,
        output_tokens: outputTokens,
        cache_read_input_tokens: 500,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 200 },
      },
    },
  };
}

const userRec = {
  type: 'user', uuid: 'u1', sessionId: 's1',
  timestamp: '2026-04-10T00:00:00Z', isSidechain: false,
  message: { role: 'user', content: 'hi' },
};

test('within-file streaming dupes collapse to final', () => {
  const p1 = streamingPartial('r1', 'msg_X', 's1', '2026-04-10T00:00:01Z', 27);
  const p2 = streamingPartial('r2', 'msg_X', 's1', '2026-04-10T00:00:02Z', 27);
  const p3 = streamingPartial('r3', 'msg_X', 's1', '2026-04-10T00:00:03Z', 303);
  writeJsonl(jsonlPath(), [userRec, p1, p2, p3]);
  scanDir(projRoot, dbPath);
  const db = new DatabaseSync(dbPath);
  const rows = db
    .prepare(
      "SELECT uuid, input_tokens, output_tokens, cache_read_tokens, cache_create_1h_tokens FROM messages WHERE type='assistant'"
    )
    .all();
  db.close();
  assert.equal(rows.length, 1);
  assert.equal(Number(rows[0].output_tokens), 303);
  assert.equal(Number(rows[0].input_tokens), 100);
  assert.equal(Number(rows[0].cache_read_tokens), 500);
  assert.equal(Number(rows[0].cache_create_1h_tokens), 200);
  assert.equal(rows[0].uuid, 'r3');
});

test('incremental scan: final replaces partial across scans', () => {
  const p1 = streamingPartial('r1', 'msg_Y', 's1', '2026-04-10T00:00:01Z', 27);
  const p2 = streamingPartial('r2', 'msg_Y', 's1', '2026-04-10T00:00:02Z', 27);
  writeJsonl(jsonlPath(), [userRec, p1, p2]);
  scanDir(projRoot, dbPath);

  const final = streamingPartial('r3', 'msg_Y', 's1', '2026-04-10T00:00:03Z', 303);
  fs.appendFileSync(jsonlPath(), JSON.stringify(final) + '\n');
  const future = Date.now() / 1000 + 5;
  fs.utimesSync(jsonlPath(), future, future);
  scanDir(projRoot, dbPath);

  const db = new DatabaseSync(dbPath);
  const rows = db.prepare("SELECT uuid, output_tokens FROM messages WHERE type='assistant'").all();
  db.close();
  assert.equal(rows.length, 1);
  assert.equal(Number(rows[0].output_tokens), 303);
  assert.equal(rows[0].uuid, 'r3');
});

test('superseded tool_calls are removed', () => {
  const recWithTool = (uuid, ts, out) => ({
    type: 'assistant', uuid, parentUuid: 'u1',
    sessionId: 's1', timestamp: ts, isSidechain: false,
    message: {
      id: 'msg_Z', model: 'claude-opus-4-7',
      content: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: 'foo.py' } }],
      usage: { input_tokens: 1, output_tokens: out },
    },
  });
  writeJsonl(jsonlPath(), [
    userRec,
    recWithTool('r1', '2026-04-10T00:00:01Z', 5),
    recWithTool('r2', '2026-04-10T00:00:02Z', 50),
  ]);
  scanDir(projRoot, dbPath);

  const db = new DatabaseSync(dbPath);
  const tools = db
    .prepare("SELECT message_uuid, tool_name FROM tool_calls WHERE tool_name='Read'")
    .all();
  db.close();
  assert.equal(tools.length, 1);
  assert.equal(tools[0].message_uuid, 'r2');
});

test('assistant without message_id falls back to uuid', () => {
  const recs = [
    userRec,
    {
      type: 'assistant', uuid: 'a1', parentUuid: 'u1', sessionId: 's1',
      timestamp: '2026-04-10T00:00:01Z', isSidechain: false,
      message: { model: 'claude-opus-4-7', usage: { input_tokens: 1, output_tokens: 1 } },
    },
    {
      type: 'assistant', uuid: 'a2', parentUuid: 'u1', sessionId: 's1',
      timestamp: '2026-04-10T00:00:02Z', isSidechain: false,
      message: { model: 'claude-opus-4-7', usage: { input_tokens: 2, output_tokens: 2 } },
    },
  ];
  writeJsonl(jsonlPath(), recs);
  scanDir(projRoot, dbPath);
  const db = new DatabaseSync(dbPath);
  const rows = db
    .prepare("SELECT uuid FROM messages WHERE type='assistant' ORDER BY uuid")
    .all();
  db.close();
  assert.deepEqual(rows.map((r) => r.uuid), ['a1', 'a2']);
});
