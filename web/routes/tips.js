import { api, fmt } from '/web/app.js';

const GLOBAL_KEY = '__global__';

const MERGE_META = {
  'repeat-file': {
    label: 'files',
    title: (n, slug) => `${n} files read repeatedly in ${slug}`,
    body: 'These files were re-opened many times over the past 7 days. A summary in CLAUDE.md or one read per session would avoid repeats.',
    row: t => `${fmt.htmlSafe(t.target)} — ${t.count} reads${t.sessions ? ` across ${t.sessions} sessions` : ''}`,
  },
  'repeat-bash': {
    label: 'commands',
    title: (n, slug) => `${n} bash commands re-run in ${slug}`,
    body: 'These bash commands ran many times over the past 7 days. Consider a watch flag or shell alias.',
    row: t => `<code>${fmt.htmlSafe(t.target)}</code> — ${t.count} runs`,
  },
};

function bucket(tips) {
  const groups = new Map();
  for (const t of tips) {
    const k = t.project_slug || GLOBAL_KEY;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  }
  const projectKeys = [...groups.keys()].filter(k => k !== GLOBAL_KEY).sort();
  if (groups.has(GLOBAL_KEY)) projectKeys.push(GLOBAL_KEY);
  return projectKeys.map(k => [k, groups.get(k)]);
}

function mergeRepeats(items, groupLabel) {
  const merged = [];
  const buckets = {};
  for (const t of items) {
    if (MERGE_META[t.category]) {
      (buckets[t.category] ||= []).push(t);
    } else {
      merged.push(t);
    }
  }
  for (const [cat, list] of Object.entries(buckets)) {
    if (list.length === 1) {
      merged.push(list[0]);
      continue;
    }
    const meta = MERGE_META[cat];
    const slug = groupLabel === GLOBAL_KEY ? '(unknown project)' : groupLabel;
    list.sort((a, b) => (b.count || 0) - (a.count || 0));
    merged.push({
      _merged: true,
      category: cat,
      title: meta.title(list.length, slug),
      body: meta.body,
      keys: list.map(t => t.key),
      rows: list.map(meta.row),
    });
  }
  return merged;
}

function tipCard(t) {
  const keysAttr = t._merged
    ? `data-keys="${fmt.htmlSafe(t.keys.join('|'))}"`
    : `data-key="${fmt.htmlSafe(t.key)}"`;
  const list = t._merged
    ? `<ul class="tip-list">${t.rows.map(r => `<li>${r}</li>`).join('')}</ul>`
    : '';
  return `
    <div class="tip">
      <div class="tip-head">
        <span class="badge">${fmt.htmlSafe(t.category)}</span>
        <strong>${fmt.htmlSafe(t.title)}</strong>
        <span class="spacer"></span>
        <button class="ghost" ${keysAttr}>dismiss${t._merged ? ' all' : ''}</button>
      </div>
      <p class="tip-body">${fmt.htmlSafe(t.body)}</p>
      ${list}
    </div>`;
}

async function dismissKeys(keys) {
  await Promise.all(keys.map(key => fetch('/api/tips/dismiss', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key }),
  })));
}

export default async function (root) {
  const tips = await api('/api/tips');
  const groups = bucket(tips).map(([k, items]) => [k, mergeRepeats(items, k)]);
  root.innerHTML = `
    <div class="card">
      <h2>Suggestions</h2>
      ${tips.length === 0
        ? '<p class="muted">No suggestions right now. Token Dashboard surfaces patterns weekly — check back after more activity.</p>'
        : `<p class="muted" style="margin:-8px 0 14px">Rule-based pattern detection over the last 7 days. Dismissed tips re-appear after 14 days.</p>`}
      ${groups.map(([k, items]) => `
        <section class="tip-group">
          <h3 class="tip-group-head">${k === GLOBAL_KEY ? 'Global' : fmt.htmlSafe(k)}</h3>
          ${items.map(tipCard).join('')}
        </section>`).join('')}
    </div>`;
  root.querySelectorAll('button[data-key]').forEach(b => {
    b.addEventListener('click', async () => {
      await dismissKeys([b.dataset.key]);
      location.reload();
    });
  });
  root.querySelectorAll('button[data-keys]').forEach(b => {
    b.addEventListener('click', async () => {
      await dismissKeys(b.dataset.keys.split('|'));
      location.reload();
    });
  });
}
