import { api, fmt } from '/web/app.js';

const GLOBAL_KEY = '__global__';

const TYPE_ORDER = [
  'cache',
  'repeat-file',
  'repeat-bash',
  'right-size',
  'tool-bloat',
  'subagent-outlier',
];

const TYPE_LABELS = {
  'cache': 'Cache discipline',
  'repeat-file': 'Repeated file reads',
  'repeat-bash': 'Repeated bash commands',
  'right-size': 'Right-sizing',
  'tool-bloat': 'Tool-result bloat',
  'subagent-outlier': 'Subagent outliers',
};

const MERGE_META = {
  'repeat-file': {
    label: 'files',
    title: (n, slug) => `${n} files read repeatedly in ${slug}`,
    body: 'These files were re-opened many times over the past 7 days. A summary in CLAUDE.md or one read per session would avoid repeats.',
    row: t => `${fmt.htmlSafe(t.target)} · ${t.count} reads${t.sessions ? ` across ${t.sessions} sessions` : ''}`,
  },
  'repeat-bash': {
    label: 'commands',
    title: (n, slug) => `${n} bash commands re-run in ${slug}`,
    body: 'These bash commands ran many times over the past 7 days. Consider a watch flag or shell alias.',
    row: t => `<code>${fmt.htmlSafe(t.target)}</code> · ${t.count} runs`,
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

function bucketByType(items) {
  const buckets = new Map();
  for (const t of items) {
    const cat = t.category || 'other';
    if (!buckets.has(cat)) buckets.set(cat, []);
    buckets.get(cat).push(t);
  }
  const known = TYPE_ORDER.filter(c => buckets.has(c));
  const unknown = [...buckets.keys()].filter(c => !TYPE_ORDER.includes(c)).sort();
  return [...known, ...unknown].map(c => [c, buckets.get(c)]);
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
      _sourceTips: list,
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

function buildPrompt(projectKey, typeBuckets, projectCwd) {
  const projectLabel = projectCwd || projectKey;
  const lines = [];
  lines.push(`# Token Dashboard suggestions for ${projectKey}`);
  lines.push('');
  lines.push(`Project path: ${projectLabel}`);
  lines.push('Window: last 7 days');
  lines.push('');

  for (const [cat, items] of typeBuckets) {
    lines.push(`## ${TYPE_LABELS[cat] || cat}`);
    lines.push('');
    if (cat === 'repeat-file') {
      const tips = items.flatMap(t => t._sourceTips || [t]);
      for (const t of tips) {
        const sessions = t.sessions ? ` across ${t.sessions} sessions` : '';
        lines.push(`- ${t.target} · ${t.count} reads${sessions}`);
      }
    } else if (cat === 'repeat-bash') {
      const tips = items.flatMap(t => t._sourceTips || [t]);
      for (const t of tips) {
        lines.push(`- \`${t.target}\` · ${t.count} runs`);
      }
    } else {
      for (const t of items) {
        lines.push(`- **${t.title}**: ${t.body}`);
      }
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push('Please propose a focused plan that addresses each of these patterns in this project. Prioritise by likely token savings. Ask before making changes.');
  return lines.join('\n');
}

async function dismissKeys(keys) {
  await Promise.all(keys.map(key => fetch('/api/tips/dismiss', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key }),
  })));
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(text); return true; } catch {}
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed'; ta.style.left = '-9999px';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch {}
  document.body.removeChild(ta);
  return ok;
}

export default async function (root) {
  const tips = await api('/api/tips');
  const projectGroups = bucket(tips).map(([projectKey, items]) => {
    const typeBuckets = bucketByType(items).map(
      ([cat, list]) => [cat, mergeRepeats(list, projectKey)]
    );
    const cwd = items.find(t => t.project_cwd)?.project_cwd || null;
    return { projectKey, typeBuckets, cwd };
  });

  root.innerHTML = `
    <div class="card">
      <h2>Suggestions</h2>
      ${tips.length === 0
        ? '<p class="muted">No suggestions right now. Token Dashboard surfaces patterns weekly — check back after more activity.</p>'
        : `<p class="muted" style="margin:-8px 0 14px">Rule-based pattern detection over the last 7 days. Dismissed tips re-appear after 14 days.</p>`}
      ${projectGroups.map(({ projectKey, typeBuckets, cwd }) => {
        const isGlobal = projectKey === GLOBAL_KEY;
        const heading = isGlobal ? 'Global' : fmt.htmlSafe(projectKey);
        const copyBtn = isGlobal
          ? ''
          : `<button class="ghost copy-prompt" data-project="${fmt.htmlSafe(projectKey)}">Copy prompt</button>`;
        const cwdLine = !isGlobal && cwd
          ? `<div class="tip-group-path muted">${fmt.htmlSafe(cwd)}</div>`
          : '';
        return `
          <section class="tip-group" data-project="${fmt.htmlSafe(projectKey)}">
            <div class="tip-group-head-row">
              <h3 class="tip-group-head">${heading}</h3>
              <span class="spacer"></span>
              ${copyBtn}
            </div>
            ${cwdLine}
            ${typeBuckets.map(([cat, mergedItems]) => `
              <div class="tip-type">
                <h4 class="tip-type-head">${fmt.htmlSafe(TYPE_LABELS[cat] || cat)}</h4>
                ${mergedItems.map(tipCard).join('')}
              </div>`).join('')}
          </section>`;
      }).join('')}
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
  root.querySelectorAll('button.copy-prompt').forEach(b => {
    b.addEventListener('click', async () => {
      const group = projectGroups.find(g => g.projectKey === b.dataset.project);
      if (!group) return;
      const prompt = buildPrompt(group.projectKey, group.typeBuckets, group.cwd);
      const ok = await copyText(prompt);
      const orig = b.textContent;
      b.textContent = ok ? 'Copied' : 'Copy failed';
      b.disabled = true;
      setTimeout(() => { b.textContent = orig; b.disabled = false; }, 1500);
    });
  });
}
