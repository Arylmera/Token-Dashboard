import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { scanCatalog, slugsFor } from '../src/skills.js';
import { makeTmpDir, cleanup } from './_helpers.js';

let tmp;
beforeEach(() => { tmp = makeTmpDir(); });
afterEach(() => cleanup(tmp));

function write(p, body) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
}

test('user skill', () => {
  write(path.join(tmp, 'skills/frontend-design/SKILL.md'), 'x'.repeat(400));
  const cat = scanCatalog([path.join(tmp, 'skills')]);
  assert.ok('frontend-design' in cat);
  assert.equal(cat['frontend-design'].chars, 400);
  assert.equal(cat['frontend-design'].tokens, 100);
});

test('plugin skill registers both slugs', () => {
  const p = path.join(
    tmp,
    'plugins/marketplaces/official/plugins/superpowers/skills/brainstorming/SKILL.md'
  );
  write(p, 'y'.repeat(800));
  const cat = scanCatalog([path.join(tmp, 'plugins')]);
  assert.ok('brainstorming' in cat);
  assert.ok('superpowers:brainstorming' in cat);
  assert.equal(cat.brainstorming.tokens, 200);
  assert.equal(cat['superpowers:brainstorming'].tokens, 200);
});

test('scheduled-task skill', () => {
  write(path.join(tmp, 'scheduled-tasks/morning-coffee/SKILL.md'), 'z'.repeat(100));
  const cat = scanCatalog([path.join(tmp, 'scheduled-tasks')]);
  assert.ok('morning-coffee' in cat);
});

test('nested skills/skills dedup prefers shallow', () => {
  write(path.join(tmp, 'skills/foo/SKILL.md'), 's'.repeat(100));
  write(path.join(tmp, 'skills/skills/foo/SKILL.md'), 'd'.repeat(999));
  const cat = scanCatalog([path.join(tmp, 'skills')]);
  assert.equal(cat.foo.chars, 100);
});

test('slugsFor plugin path', () => {
  const slugs = new Set(
    slugsFor('plugins/marketplaces/x/plugins/superpowers/skills/brainstorming/SKILL.md')
  );
  assert.ok(slugs.has('brainstorming'));
  assert.ok(slugs.has('superpowers:brainstorming'));
});

test('slugsFor cache versioned path', () => {
  const slugs = new Set(
    slugsFor('plugins/cache/claude-plugins-official/superpowers/5.0.7/skills/brainstorming/SKILL.md')
  );
  assert.ok(slugs.has('brainstorming'));
  assert.ok(slugs.has('superpowers:brainstorming'));
  assert.ok(!slugs.has('5.0.7:brainstorming'));
});

test('slugsFor user skill', () => {
  assert.deepEqual(slugsFor('.claude/skills/frontend-design/SKILL.md'), ['frontend-design']);
});

test('missing skill not in catalog', () => {
  const cat = scanCatalog([path.join(tmp, 'skills')]);
  assert.ok(!('never-installed' in cat));
});
