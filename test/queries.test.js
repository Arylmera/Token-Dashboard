import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  initDb, overviewTotals, expensivePrompts, projectSummary,
  toolTokenBreakdown, recentSessions, sessionTurns,
  dailyTokenBreakdown, modelBreakdown, skillBreakdown,
  projectNameFor,
} from '../src/db.js';
import { makeTmpDir, cleanup } from './_helpers.js';

let tmp, dbPath;

function seed(sql) {
  const db = new DatabaseSync(dbPath);
  db.exec(sql);
  db.close();
}

beforeEach(() => {
  tmp = makeTmpDir();
  dbPath = path.join(tmp, 'q.db');
  initDb(dbPath);
});
afterEach(() => cleanup(tmp));

function seedQuerySet() {
  seed(`
    INSERT INTO messages (uuid, parent_uuid, session_id, project_slug, type, timestamp, model,
      input_tokens, output_tokens, cache_read_tokens, cache_create_5m_tokens, cache_create_1h_tokens,
      prompt_text, prompt_chars)
    VALUES
      ('u1',NULL,'s1','projA','user','2026-04-10T00:00:00Z',NULL,0,0,0,0,0,'big prompt',10),
      ('a1','u1','s1','projA','assistant','2026-04-10T00:00:01Z','claude-opus-4-7',100,200,300,0,0,NULL,NULL),
      ('u2',NULL,'s2','projB','user','2026-04-11T00:00:00Z',NULL,0,0,0,0,0,'small',5),
      ('a2','u2','s2','projB','assistant','2026-04-11T00:00:01Z','claude-sonnet-4-6',5,5,0,0,0,NULL,NULL);
    INSERT INTO tool_calls (message_uuid, session_id, project_slug, tool_name, target, timestamp, is_error)
    VALUES ('a1','s1','projA','Read','foo.py','2026-04-10T00:00:01Z',0),
           ('a1','s1','projA','Bash','npm test','2026-04-10T00:00:01Z',0);
  `);
}

test('overview totals', () => {
  seedQuerySet();
  const t = overviewTotals(dbPath);
  assert.equal(t.sessions, 2);
  assert.equal(t.turns, 2);
  assert.equal(t.input_tokens, 105);
  assert.equal(t.output_tokens, 205);
});

test('expensive_prompts orders by tokens', () => {
  seedQuerySet();
  const rows = expensivePrompts(dbPath, { limit: 10 });
  assert.ok(rows.length >= 2);
  assert.equal(rows[0].prompt_text, 'big prompt');
});

test('expensive_prompts sort=recent', () => {
  seedQuerySet();
  const rows = expensivePrompts(dbPath, { limit: 10, sort: 'recent' });
  assert.equal(rows[0].prompt_text, 'small');
  assert.equal(rows[1].prompt_text, 'big prompt');
});

test('project summary groups', () => {
  seedQuerySet();
  const rows = projectSummary(dbPath);
  const slugs = Object.fromEntries(rows.map((r) => [r.project_slug, r]));
  assert.ok('projA' in slugs);
  assert.equal(slugs.projA.turns, 1);
});

test('tool breakdown', () => {
  seedQuerySet();
  const rows = toolTokenBreakdown(dbPath);
  const names = new Set(rows.map((r) => r.tool_name));
  assert.ok(names.has('Read'));
  assert.ok(names.has('Bash'));
});

test('recent sessions newest first', () => {
  seedQuerySet();
  const rows = recentSessions(dbPath, { limit: 5 });
  assert.equal(rows[0].session_id, 's2');
});

test('session turns', () => {
  seedQuerySet();
  const rows = sessionTurns(dbPath, 's1');
  assert.equal(rows.length, 2);
});

test('daily token breakdown groups by day', () => {
  seedQuerySet();
  const rows = dailyTokenBreakdown(dbPath);
  const days = Object.fromEntries(rows.map((r) => [r.day, r]));
  assert.ok('2026-04-10' in days);
  assert.ok('2026-04-11' in days);
  assert.equal(days['2026-04-10'].input_tokens, 100);
  assert.equal(days['2026-04-10'].output_tokens, 200);
  assert.equal(days['2026-04-10'].cache_read_tokens, 300);
});

test('daily token breakdown respects since', () => {
  seedQuerySet();
  const rows = dailyTokenBreakdown(dbPath, '2026-04-11T00:00:00Z');
  assert.deepEqual(rows.map((r) => r.day), ['2026-04-11']);
});

test('model breakdown groups + respects since', () => {
  seedQuerySet();
  const rows = modelBreakdown(dbPath);
  const models = new Set(rows.map((r) => r.model));
  assert.ok(models.has('claude-opus-4-7'));
  assert.ok(models.has('claude-sonnet-4-6'));
  const opus = rows.find((r) => r.model === 'claude-opus-4-7');
  assert.equal(opus.input_tokens, 100);

  const filtered = modelBreakdown(dbPath, '2026-04-11T00:00:00Z');
  assert.deepEqual(filtered.map((r) => r.model), ['claude-sonnet-4-6']);
});

function seedSkillSet() {
  seed(`
    INSERT INTO messages (uuid, session_id, project_slug, type, timestamp)
    VALUES
      ('u1','s1','pA','user','2026-04-10T00:00:00Z'),
      ('a1','s1','pA','assistant','2026-04-10T00:00:01Z'),
      ('u2','s2','pA','user','2026-04-11T00:00:00Z'),
      ('a2','s2','pA','assistant','2026-04-11T00:00:01Z');
    INSERT INTO tool_calls (message_uuid, session_id, project_slug, tool_name, target, result_tokens, timestamp, is_error)
    VALUES
      ('a1','s1','pA','Skill','brainstorming',NULL,'2026-04-10T00:00:01Z',0),
      ('u1','s1','pA','_tool_result','use-123',500,'2026-04-10T00:00:05Z',0),
      ('a1','s1','pA','Skill','brainstorming',NULL,'2026-04-10T00:00:30Z',0),
      ('u1','s1','pA','_tool_result','use-124',800,'2026-04-10T00:00:32Z',0),
      ('a2','s2','pA','Skill','create-skill',NULL,'2026-04-11T00:00:01Z',0),
      ('u2','s2','pA','_tool_result','use-125',1200,'2026-04-11T00:00:02Z',0);
  `);
}

test('skill_breakdown groups by skill', () => {
  seedSkillSet();
  const rows = skillBreakdown(dbPath);
  const byName = Object.fromEntries(rows.map((r) => [r.skill, r]));
  assert.equal(byName.brainstorming.invocations, 2);
  assert.equal(byName.brainstorming.sessions, 1);
  assert.equal(byName['create-skill'].invocations, 1);
});

test('skill_breakdown orders by invocations', () => {
  seedSkillSet();
  const rows = skillBreakdown(dbPath);
  assert.equal(rows[0].skill, 'brainstorming');
});

test('skill_breakdown respects since', () => {
  seedSkillSet();
  const rows = skillBreakdown(dbPath, '2026-04-11T00:00:00Z');
  assert.deepEqual(rows.map((r) => r.skill), ['create-skill']);
});

test('projectNameFor: posix cwd basename', () => {
  assert.equal(projectNameFor('/Users/x/foo', 'slug'), 'foo');
});

test('projectNameFor: windows cwd basename', () => {
  assert.equal(
    projectNameFor('C:\\Users\\alice\\projects\\Token Dashboard', 'anything'),
    'Token Dashboard'
  );
});

test('projectNameFor: trailing slash stripped', () => {
  assert.equal(projectNameFor('/a/b/c/', 'slug'), 'c');
});

test('projectNameFor: fallback uses last dash segment', () => {
  assert.equal(projectNameFor(null, 'C--Users-x-Foo-Bar'), 'Bar');
});

test('projectNameFor: fallback single segment', () => {
  assert.equal(projectNameFor(null, 'projA'), 'projA');
});

test('projectNameFor: empty', () => {
  assert.equal(projectNameFor(null, ''), '');
});

test('projectNameFor: walks up cwd to project root', () => {
  assert.equal(
    projectNameFor(
      'C:\\Users\\alice\\projects\\MyProject\\subdir',
      'C--Users-alice-projects-MyProject'
    ),
    'MyProject'
  );
});

test('projectNameFor: walks up preserves spaces', () => {
  assert.equal(
    projectNameFor(
      'C:\\Users\\alice\\projects\\Token Dashboard\\src\\subdir',
      'C--Users-alice-projects-Token-Dashboard'
    ),
    'Token Dashboard'
  );
});

function seedNameSet() {
  seed(`
    INSERT INTO messages (uuid, session_id, project_slug, cwd, type, timestamp,
      input_tokens, output_tokens, cache_read_tokens, cache_create_5m_tokens, cache_create_1h_tokens)
    VALUES
      ('u1','s1','C--Users-x-My-Repo','/Users/x/My Repo','user','2026-04-10T00:00:00Z',0,0,0,0,0),
      ('a1','s1','C--Users-x-My-Repo','/Users/x/My Repo','assistant','2026-04-10T00:00:01Z',10,20,0,0,0),
      ('u2','s2','slugOnly',NULL,'user','2026-04-11T00:00:00Z',0,0,0,0,0),
      ('a2','s2','slugOnly',NULL,'assistant','2026-04-11T00:00:01Z',5,5,0,0,0);
  `);
}

test('project_summary uses cwd basename', () => {
  seedNameSet();
  const rows = projectSummary(dbPath);
  const names = Object.fromEntries(rows.map((r) => [r.project_slug, r.project_name]));
  assert.equal(names['C--Users-x-My-Repo'], 'My Repo');
  assert.equal(names.slugOnly, 'slugOnly');
});

test('recent_sessions has project_name', () => {
  seedNameSet();
  const rows = recentSessions(dbPath);
  const bySid = Object.fromEntries(rows.map((r) => [r.session_id, r]));
  assert.equal(bySid.s1.project_name, 'My Repo');
  assert.equal(bySid.s2.project_name, 'slugOnly');
});
