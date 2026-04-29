// states.js — shared loading / empty / error UI helpers.
// All renderers return HTML strings so route modules can drop them
// straight into innerHTML without an extra DOM step.

import { fmt } from '/web/core/format.js';

/**
 * Skeleton placeholder shown before a route's data arrives.
 * Mirrors the typical Overview shape (KPI row + a couple of cards).
 * Routes that look very different can pass `shape: 'table'` for a
 * tabular skeleton instead.
 */
export function skeleton(opts = {}) {
  const shape = opts.shape || 'cards';
  if (shape === 'table') {
    const rows = opts.rows || 8;
    const cells = '<td><span class="sk-bar"></span></td>'.repeat(opts.cols || 4);
    const body = `<tr>${cells}</tr>`.repeat(rows);
    return `
      <div class="card sk-card">
        <table class="sk-table"><tbody>${body}</tbody></table>
      </div>`;
  }
  // default: a 3-tile KPI row + 2 wide cards
  return `
    <div class="row cols-3 sk-card-group">
      <div class="card kpi"><span class="sk-bar sk-label"></span><span class="sk-bar sk-value"></span></div>
      <div class="card kpi"><span class="sk-bar sk-label"></span><span class="sk-bar sk-value"></span></div>
      <div class="card kpi"><span class="sk-bar sk-label"></span><span class="sk-bar sk-value"></span></div>
    </div>
    <div class="row cols-2 sk-card-group" style="margin-top:16px">
      <div class="card sk-card"><span class="sk-bar sk-block"></span></div>
      <div class="card sk-card"><span class="sk-bar sk-block"></span></div>
    </div>`;
}

/**
 * Empty-state card. Use when the request succeeded but there is no
 * data to show. `hint` should teach the interface, not just say "empty".
 */
export function empty(opts = {}) {
  const title = opts.title || 'No data yet';
  const hint = opts.hint || 'Nothing to show here.';
  const action = opts.action
    ? `<button class="ghost" data-empty-action>${fmt.htmlSafe(opts.action.label)}</button>`
    : '';
  return `
    <div class="card empty-state">
      <div class="empty-title">${fmt.htmlSafe(title)}</div>
      <div class="empty-hint">${fmt.htmlSafe(hint)}</div>
      ${action}
    </div>`;
}

/**
 * Error card with a Retry button. `err` may be an Error or a string.
 * The retry handler is wired by `mountRetry` after the HTML is in the DOM.
 */
export function errorCard(err, opts = {}) {
  const message = err && err.message ? err.message : String(err || 'Something broke.');
  const detail = err && err.stack ? err.stack : '';
  const showRetry = opts.retry !== false;
  return `
    <div class="card error-state" data-error-card>
      <div class="error-title">Could not load this view</div>
      <div class="error-message">${fmt.htmlSafe(message)}</div>
      ${showRetry ? '<button class="primary" data-error-retry>Try again</button>' : ''}
      ${detail ? `<details class="error-detail"><summary>Details</summary><pre>${fmt.htmlSafe(detail)}</pre></details>` : ''}
    </div>`;
}

/**
 * After rendering an error card, call this to wire the retry button
 * to a handler. `root` is the container that holds the card.
 */
export function mountRetry(root, handler) {
  const btn = root.querySelector('[data-error-retry]');
  if (btn) btn.addEventListener('click', handler, { once: true });
}

/**
 * Transient toast for non-blocking notifications (SSE dropped, refresh
 * failed, etc.). Stacks bottom-right; auto-dismisses after `ms` ms.
 */
let toastHost = null;
export function toast(message, opts = {}) {
  if (!toastHost) {
    toastHost = document.createElement('div');
    toastHost.className = 'toast-host';
    document.body.appendChild(toastHost);
  }
  const kind = opts.kind || 'info';
  const ms = opts.ms || 4000;
  const node = document.createElement('div');
  node.className = `toast toast-${kind}`;
  node.textContent = message;
  toastHost.appendChild(node);
  // Force a frame so the enter transition runs.
  requestAnimationFrame(() => node.classList.add('toast-in'));
  setTimeout(() => {
    node.classList.remove('toast-in');
    node.classList.add('toast-out');
    setTimeout(() => node.remove(), 200);
  }, ms);
}
