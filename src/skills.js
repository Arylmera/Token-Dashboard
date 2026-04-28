import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_ROOTS = [
  path.join(os.homedir(), '.claude', 'skills'),
  path.join(os.homedir(), '.claude', 'scheduled-tasks'),
  path.join(os.homedir(), '.claude', 'plugins'),
];

const VERSION_RE = /^\d+\.\d+/;
const STRUCTURE_NAMES = new Set(['skills', 'plugins', 'marketplaces', 'cache', '.claude']);

export function slugsFor(skillMd) {
  const parts = skillMd.split(/[/\\]/).filter(Boolean);
  if (path.basename(skillMd) !== 'SKILL.md') return [];
  if (!parts.includes('SKILL.md')) return [];
  const skillName = parts[parts.length - 2];
  if (!skillName) return [];
  const slugs = new Set([skillName]);
  let skillsIdx = -1;
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i] === 'skills') { skillsIdx = i; break; }
  }
  if (skillsIdx === -1) return [...slugs];
  for (const seg of parts.slice(0, skillsIdx)) {
    if (!seg || STRUCTURE_NAMES.has(seg)) continue;
    if (VERSION_RE.test(seg)) continue;
    if (seg.startsWith('temp_git_')) continue;
    if (seg.endsWith(':') || seg.includes(':')) continue;
    slugs.add(`${seg}:${skillName}`);
  }
  return [...slugs].sort();
}

function* walkSkillMd(root) {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile() && e.name === 'SKILL.md') yield full;
    }
  }
}

export function scanCatalog(roots = DEFAULT_ROOTS) {
  const catalog = {};
  for (const root of roots) {
    let st;
    try { st = fs.statSync(root); } catch { continue; }
    if (!st.isDirectory()) continue;
    for (const md of walkSkillMd(root)) {
      let chars;
      try {
        chars = fs.statSync(md).size;
      } catch {
        continue;
      }
      const entry = { path: md, chars, tokens: Math.floor(chars / 4) };
      const partsLen = md.split(/[/\\]/).length;
      for (const slug of slugsFor(md)) {
        const prev = catalog[slug];
        if (!prev || partsLen < prev.path.split(/[/\\]/).length) {
          catalog[slug] = entry;
        }
      }
    }
  }
  return catalog;
}

const _cache = { at: 0, data: {} };
const TTL_SECONDS = 60;

export function cachedCatalog() {
  const now = Date.now() / 1000;
  if (now - _cache.at > TTL_SECONDS) {
    _cache.data = scanCatalog();
    _cache.at = now;
  }
  return _cache.data;
}

export function tokensFor(slug, catalog = null) {
  const cat = catalog || cachedCatalog();
  const info = cat[slug];
  return info ? info.tokens : null;
}
