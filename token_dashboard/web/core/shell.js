// shell.js — topbar, first-run modal, SSE wiring, boot

import { $ } from '/web/core/dom.js';
import { api, state } from '/web/core/api.js';
import { ROUTES, render } from '/web/core/router.js';
import { getTheme, setTheme, THEMES } from '/web/core/settings.js';

const THEME_LABELS = {
  dark:   '🌙 Dark',
  light:  '☀️ Light',
  forge:  '🔥 Forge',
  forest: '🌲 Forest',
};

function buildTopbar() {
  const wrap = document.createElement('header');
  wrap.className = 'topbar';
  wrap.innerHTML = `
    <div class="brand">Token Dashboard</div>
    <nav>
      ${Object.keys(ROUTES).map(p => `<a href="#${p}" data-route="${p}">${p.slice(1)}</a>`).join('')}
    </nav>
    <div class="spacer"></div>
    <button class="pill pill-btn" id="refresh-btn" title="Rescan JSONL files now and re-render">↻ Refresh</button>
    <span class="pill" id="plan-pill">api</span>
    <div class="menu" id="theme-menu">
      <button class="pill pill-btn" id="theme-btn" title="Theme" aria-haspopup="menu" aria-expanded="false">≡</button>
      <div class="menu-panel" role="menu" hidden>
        ${THEMES.map(id => `<button class="menu-item" role="menuitemradio" data-theme="${id}">${THEME_LABELS[id]}</button>`).join('')}
      </div>
    </div>
  `;
  document.body.prepend(wrap);

  const themeMenu  = wrap.querySelector('#theme-menu');
  const themeBtn   = themeMenu.querySelector('#theme-btn');
  const themePanel = themeMenu.querySelector('.menu-panel');

  const paintActive = () => {
    const cur = getTheme();
    themePanel.querySelectorAll('.menu-item').forEach(it => {
      it.setAttribute('aria-checked', it.dataset.theme === cur ? 'true' : 'false');
    });
  };
  const closeMenu = () => {
    themePanel.hidden = true;
    themeBtn.setAttribute('aria-expanded', 'false');
  };
  const openMenu = () => {
    paintActive();
    themePanel.hidden = false;
    themeBtn.setAttribute('aria-expanded', 'true');
  };
  paintActive();

  themeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (themePanel.hidden) openMenu(); else closeMenu();
  });
  themePanel.addEventListener('click', async (e) => {
    const item = e.target.closest('.menu-item');
    if (!item) return;
    setTheme(item.dataset.theme);
    paintActive();
    closeMenu();
    await render();
  });
  document.addEventListener('mousedown', (e) => {
    if (!themePanel.hidden && !themeMenu.contains(e.target)) closeMenu();
  });

  wrap.querySelector('#refresh-btn').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    if (btn.dataset.busy === '1') return;
    btn.dataset.busy = '1';
    btn.classList.add('is-busy');
    try {
      await api('/api/scan');
      await render();
    } catch (err) {
      console.warn('refresh failed', err);
    } finally {
      btn.dataset.busy = '';
      btn.classList.remove('is-busy');
    }
  });
}

async function firstRun() {
  if (localStorage.getItem('td.plan-set')) return;
  const plans = Object.entries(state.pricing.plans);
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <h2>Welcome — pick your plan</h2>
      <p>This sets how costs are displayed. Change it later in Settings.</p>
      <select id="firstplan" style="width:100%">
        ${plans.map(([k,v]) => `<option value="${k}">${v.label}${v.monthly ? ` — $${v.monthly}/mo` : ''}</option>`).join('')}
      </select>
      <div class="actions">
        <div class="spacer"></div>
        <button class="primary" id="firstsave">Continue</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  await new Promise(res => $('#firstsave', overlay).addEventListener('click', async () => {
    const plan = $('#firstplan', overlay).value;
    await fetch('/api/plan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plan }) });
    localStorage.setItem('td.plan-set', '1');
    overlay.remove();
    res();
  }));
  state.plan = (await api('/api/plan')).plan;
}

export async function boot() {
  setTheme(getTheme());
  buildTopbar();
  const planResp = await api('/api/plan');
  state.plan = planResp.plan;
  state.pricing = planResp.pricing;
  $('#plan-pill').textContent = state.plan;

  await firstRun();

  window.addEventListener('hashchange', render);
  await render();

  // SSE diff stream — coalesce bursts, keep at most one render in flight + one queued
  let pending = false;
  let inflight = null;
  function scheduleRender() {
    if (inflight) { pending = true; return; }
    inflight = render().finally(() => {
      inflight = null;
      if (pending) { pending = false; scheduleRender(); }
    });
  }
  try {
    const es = new EventSource('/api/stream');
    es.onmessage = ev => {
      try {
        const evt = JSON.parse(ev.data);
        if (evt.type === 'scan') scheduleRender();
      } catch {}
    };
  } catch {}
}
