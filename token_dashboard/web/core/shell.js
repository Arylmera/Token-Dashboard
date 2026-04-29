// shell.js — topbar, first-run modal, SSE wiring, boot

import { $ } from '/web/core/dom.js';
import { api, state } from '/web/core/api.js';
import { ROUTES, render } from '/web/core/router.js';
import { getTheme, setTheme, THEMES } from '/web/core/settings.js';
import { toast } from '/web/core/states.js';

const THEME_LABELS = {
  dark:   'Dark',
  light:  'Light',
  forge:  'Forge',
  forest: 'Forest',
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
      <button class="pill pill-btn" id="theme-btn" title="Theme" aria-haspopup="menu" aria-expanded="false">Theme</button>
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
      toast('Refresh failed: ' + (err && err.message ? err.message : err), { kind: 'error' });
    } finally {
      btn.dataset.busy = '';
      btn.classList.remove('is-busy');
    }
  });
}

/**
 * First-run nudge. Shows a dismissible banner above the app inviting the
 * user to confirm their billing plan. Non-blocking: data renders
 * immediately under the API-rate default, and the user can ignore the
 * banner indefinitely. Dismissal is sticky via localStorage.
 */
function firstRunBanner() {
  if (localStorage.getItem('td.plan-set')) return;
  const banner = document.createElement('div');
  banner.className = 'banner';
  banner.innerHTML = `
    <div class="banner-body">
      Showing costs at API rates. Set your billing plan for accurate numbers.
    </div>
    <div class="banner-actions">
      <a href="#/settings" class="banner-link" data-banner-go>Go to Settings</a>
      <button class="ghost" data-banner-dismiss aria-label="Dismiss">Dismiss</button>
    </div>`;
  const main = document.querySelector('main#app');
  if (main && main.parentNode) main.parentNode.insertBefore(banner, main);
  const close = () => {
    localStorage.setItem('td.plan-set', '1');
    banner.remove();
  };
  banner.querySelector('[data-banner-dismiss]').addEventListener('click', close);
  banner.querySelector('[data-banner-go]').addEventListener('click', close);
}

export async function boot() {
  setTheme(getTheme());
  buildTopbar();
  const planResp = await api('/api/plan');
  state.plan = planResp.plan;
  state.pricing = planResp.pricing;
  $('#plan-pill').textContent = state.plan;

  firstRunBanner();

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
    let warned = false;
    es.onmessage = ev => {
      try {
        const evt = JSON.parse(ev.data);
        if (evt.type === 'scan') scheduleRender();
      } catch {}
    };
    es.onerror = () => {
      // EventSource auto-reconnects, so surface only the first failure
      // per session: stale data during a long backend outage is the
      // worst-case silent failure here.
      if (!warned && es.readyState === EventSource.CLOSED) {
        warned = true;
        toast('Live updates stopped. Use Refresh.', { kind: 'warn', ms: 6000 });
      }
    };
  } catch (err) {
    toast('Live updates unavailable.', { kind: 'warn' });
  }
}
