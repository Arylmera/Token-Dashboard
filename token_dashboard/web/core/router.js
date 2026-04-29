// router.js — hash-based route table and renderer

import { $, $$ } from '/web/core/dom.js';
import { errorCard, mountRetry, skeleton } from '/web/core/states.js';

export const ROUTES = {
  '/overview': () => import('/web/routes/overview.js'),
  '/prompts':  () => import('/web/routes/prompts.js'),
  '/sessions': () => import('/web/routes/sessions.js'),
  '/projects': () => import('/web/routes/projects.js'),
  '/skills':   () => import('/web/routes/skills.js'),
  '/tips':     () => import('/web/routes/tips.js'),
  '/settings': () => import('/web/routes/settings.js'),
};

export function setActiveTab(routeKey) {
  $$('header.topbar nav a').forEach(a => a.classList.toggle('active', a.dataset.route === routeKey));
}

let lastKey = null;

export async function render() {
  const hash = location.hash.replace(/^#/, '') || '/overview';
  const path = hash.split('?')[0];
  let key = path;
  if (path.startsWith('/sessions/')) key = '/sessions';
  setActiveTab(key);
  const loader = ROUTES[key] || ROUTES['/overview'];
  const app = $('#app');

  // Show a skeleton when navigating to a different route. Same-route
  // re-renders (SSE refreshes) keep the previous content until the new
  // render swaps in, to avoid flicker.
  if (key !== lastKey) {
    app.innerHTML = skeleton({ shape: key === '/prompts' || key === '/sessions' ? 'table' : 'cards' });
  }
  lastKey = key;

  let mod;
  try {
    mod = await loader();
  } catch (e) {
    app.innerHTML = errorCard(e);
    mountRetry(app, () => render());
    return;
  }

  try {
    await mod.default(app);
  } catch (e) {
    app.innerHTML = errorCard(e);
    mountRetry(app, () => render());
  }
}
