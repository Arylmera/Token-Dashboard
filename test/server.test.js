import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { initDb } from '../src/db.js';
import { run } from '../src/server.js';
import { makeTmpDir, cleanup } from './_helpers.js';

let tmp, dbPath, handle, base;

beforeEach(async () => {
  tmp = makeTmpDir();
  dbPath = path.join(tmp, 't.db');
  initDb(dbPath);
  const db = new DatabaseSync(dbPath);
  db.exec(`
    INSERT INTO messages (uuid, parent_uuid, session_id, project_slug, type, timestamp, model, input_tokens, output_tokens, cache_read_tokens, cache_create_5m_tokens, cache_create_1h_tokens, prompt_text, prompt_chars)
    VALUES ('u',NULL,'s','p','user','2026-04-19T00:00:00Z',NULL,0,0,0,0,0,'hi',2);
    INSERT INTO messages (uuid, parent_uuid, session_id, project_slug, type, timestamp, model, input_tokens, output_tokens, cache_read_tokens, cache_create_5m_tokens, cache_create_1h_tokens)
    VALUES ('a','u','s','p','assistant','2026-04-19T00:00:01Z','claude-haiku-4-5',1,1,0,0,0);
  `);
  db.close();

  handle = await run({ host: '127.0.0.1', port: 0, dbPath, projectsDir: '/nonexistent' });
  const { port } = handle.server.address();
  base = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await handle.close();
  cleanup(tmp);
});

async function get(p) {
  const r = await fetch(base + p);
  if (!r.ok) throw new Error(`HTTP ${r.status} on ${p}`);
  return r;
}

test('GET / serves index.html', async () => {
  const text = await (await get('/')).text();
  assert.ok(text.includes('Token Dashboard'));
});

test('GET /api/overview', async () => {
  const body = await (await get('/api/overview')).json();
  assert.ok('sessions' in body);
  assert.equal(body.sessions, 1);
});

test('GET /api/prompts is a list', async () => {
  const body = await (await get('/api/prompts?limit=10')).json();
  assert.ok(Array.isArray(body));
});

test('GET /api/sessions with since= returns 200', async () => {
  const r = await fetch(base + '/api/sessions?limit=10&since=2026-03-29T14:32:47.410Z');
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.ok(Array.isArray(body));
});

test('GET /api/projects', async () => {
  const body = await (await get('/api/projects')).json();
  assert.ok(Array.isArray(body));
  assert.equal(body[0].project_slug, 'p');
});

test('GET /api/plan', async () => {
  const body = await (await get('/api/plan')).json();
  assert.ok('plan' in body);
  assert.ok('pricing' in body);
});

test('HEAD / returns 200 and empty body', async () => {
  const r = await fetch(base + '/', { method: 'HEAD' });
  assert.equal(r.status, 200);
  assert.equal(await r.text(), '');
});

test('HEAD /api/overview returns 200 and empty body', async () => {
  const r = await fetch(base + '/api/overview', { method: 'HEAD' });
  assert.equal(r.status, 200);
  assert.equal(await r.text(), '');
});

test('POST /api/plan persists', async () => {
  const r = await fetch(base + '/api/plan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ plan: 'pro' }),
  });
  assert.equal(r.status, 200);
  const data = await r.json();
  assert.equal(data.ok, true);
  const after = await (await get('/api/plan')).json();
  assert.equal(after.plan, 'pro');
});
