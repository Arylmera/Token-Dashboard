import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseRecord } from '../src/scanner.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

function load(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));
}

test('parses assistant usage', () => {
  const [msg, tools] = parseRecord(load('simple_assistant.json'), 'proj-x');
  assert.equal(msg.uuid, 'msg-1');
  assert.equal(msg.session_id, 'sess-1');
  assert.equal(msg.project_slug, 'proj-x');
  assert.equal(msg.model, 'claude-opus-4-7');
  assert.equal(msg.input_tokens, 10);
  assert.equal(msg.output_tokens, 5);
  assert.equal(msg.cache_read_tokens, 100);
  assert.equal(msg.cache_create_5m_tokens, 30);
  assert.equal(msg.cache_create_1h_tokens, 20);
  assert.equal(msg.is_sidechain, 0);
  assert.equal(msg.agent_id, null);
  assert.deepEqual(tools, []);
});

test('extracts tool uses', () => {
  const rec = load('tool_use_assistant.json');
  const [msg, tools] = parseRecord(rec, 'p');
  assert.equal(tools.length, 2);
  assert.deepEqual(tools.map((t) => t.tool_name), ['Read', 'Bash']);
  assert.equal(tools[0].target, 'C:/proj/foo.py');
  assert.equal(tools[1].target, 'npm run lint');
  assert.ok(msg.tool_calls_json);
  const parsed = JSON.parse(msg.tool_calls_json);
  assert.equal(parsed[0].name, 'Read');
  assert.equal(parsed[1].target, 'npm run lint');
});

test('is_sidechain flag propagates', () => {
  const rec = {
    type: 'assistant',
    uuid: 'u',
    sessionId: 's',
    timestamp: 't',
    isSidechain: true,
    agentId: 'agent-explore-1',
    message: { model: 'claude-sonnet-4-6', usage: { input_tokens: 1, output_tokens: 1 } },
  };
  const [msg] = parseRecord(rec, 'p');
  assert.equal(msg.is_sidechain, 1);
  assert.equal(msg.agent_id, 'agent-explore-1');
});

test('tool_result estimates tokens', () => {
  const rec = {
    type: 'user',
    uuid: 'u2',
    sessionId: 's',
    timestamp: 't',
    isSidechain: false,
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'tu1', content: 'x'.repeat(4000), is_error: false },
      ],
    },
  };
  const [msg, tools] = parseRecord(rec, 'p');
  assert.equal(msg.type, 'user');
  assert.equal(tools.length, 1);
  assert.equal(tools[0].tool_name, '_tool_result');
  assert.ok(Math.abs(tools[0].result_tokens - 1000) <= 10);
});
