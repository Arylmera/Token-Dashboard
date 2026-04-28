import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeTmpDir, cleanup } from './_helpers.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'cli.js');

let tmp, projDir, dbPath;

beforeEach(() => {
  tmp = makeTmpDir();
  projDir = path.join(tmp, 'projects');
  fs.mkdirSync(path.join(projDir, 'demo'), { recursive: true });
  fs.writeFileSync(
    path.join(projDir, 'demo', 's.jsonl'),
    '{"type":"user","uuid":"u1","sessionId":"s1","timestamp":"2026-04-19T00:00:00Z","isSidechain":false,"message":{"role":"user","content":"hi"}}\n' +
      '{"type":"assistant","uuid":"a1","parentUuid":"u1","sessionId":"s1","timestamp":"2026-04-19T00:00:01Z","isSidechain":false,"message":{"model":"claude-haiku-4-5","usage":{"input_tokens":1,"output_tokens":1}}}\n'
  );
  dbPath = path.join(tmp, 't.db');
});

afterEach(() => cleanup(tmp));

function runCli(...args) {
  return spawnSync(
    process.execPath,
    ['--experimental-sqlite', CLI, ...args],
    {
      cwd: ROOT,
      env: { ...process.env, TOKEN_DASHBOARD_DB: dbPath },
      encoding: 'utf8',
    }
  );
}

test('scan then today', () => {
  const r1 = runCli('scan', '--projects-dir', projDir);
  assert.equal(r1.status, 0, r1.stderr);
  assert.ok(r1.stdout.includes('scanned'));
  const r2 = runCli('today');
  assert.equal(r2.status, 0, r2.stderr);
  assert.ok(r2.stdout.includes('Token Dashboard'));
});

test('stats', () => {
  runCli('scan', '--projects-dir', projDir);
  const r = runCli('stats');
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('all time'));
});

test('tips runs without data', () => {
  const r = runCli('tips');
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('no suggestions'));
});
