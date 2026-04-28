import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { initDb, overviewTotals } from '../src/db.js';
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

const userRec = (uuid, ts, text) => ({
  type: 'user', uuid, sessionId: 's1',
  timestamp: ts, isSidechain: false,
  message: { role: 'user', content: text },
});

const assistantRec = (uuid, parent, msgId, ts, usage, toolUses = null) => {
  const content = [{ type: 'text', text: '...' }];
  if (toolUses) content.push(...toolUses);
  return {
    type: 'assistant', uuid, parentUuid: parent,
    sessionId: 's1', timestamp: ts, isSidechain: false,
    message: { id: msgId, model: 'claude-opus-4-7', content, usage },
  };
};

const usage = (inp, out, cr, c5, c1) => ({
  input_tokens: inp,
  output_tokens: out,
  cache_read_input_tokens: cr,
  cache_creation: { ephemeral_5m_input_tokens: c5, ephemeral_1h_input_tokens: c1 },
});

test('scan totals match hand-computed sums', () => {
  const records = [
    userRec('u1', '2026-04-10T00:00:00Z', 'prompt 1'),
    assistantRec('a1', 'u1', 'msg_A', '2026-04-10T00:00:01Z', usage(100, 10, 500, 200, 0)),
    assistantRec('a2', 'u1', 'msg_A', '2026-04-10T00:00:02Z', usage(100, 200, 500, 200, 50)),
    userRec('u2', '2026-04-10T00:01:00Z', 'prompt 2'),
    assistantRec('a3', 'u2', 'msg_B', '2026-04-10T00:01:01Z',
      usage(50, 80, 300, 0, 100),
      [{ type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: 'foo.py' } }]
    ),
    assistantRec('a4', 'u2', 'msg_C', '2026-04-10T00:01:02Z', usage(60, 120, 350, 30, 0)),
  ];

  const file = path.join(projDir, 's1.jsonl');
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');

  scanDir(projRoot, dbPath);

  const t = overviewTotals(dbPath);
  assert.equal(t.sessions, 1);
  assert.equal(t.turns, 2);
  assert.equal(t.input_tokens, 210);
  assert.equal(t.output_tokens, 400);
  assert.equal(t.cache_read_tokens, 1150);
  assert.equal(t.cache_create_5m_tokens, 230);
  assert.equal(t.cache_create_1h_tokens, 150);

  const db = new DatabaseSync(dbPath);
  const aUuids = db
    .prepare("SELECT uuid FROM messages WHERE type='assistant' ORDER BY uuid")
    .all()
    .map((r) => r.uuid);
  const toolCount = db
    .prepare("SELECT COUNT(*) AS n FROM tool_calls WHERE tool_name='Read'")
    .get();
  db.close();
  assert.deepEqual(aUuids, ['a2', 'a3', 'a4']);
  assert.equal(Number(toolCount.n), 1);
});
