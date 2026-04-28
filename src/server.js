import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  overviewTotals, expensivePrompts, projectSummary,
  toolTokenBreakdown, recentSessions, sessionTurns,
  dailyTokenBreakdown, modelBreakdown, skillBreakdown,
} from './db.js';
import { loadPricing, costFor, getPlan, setPlan } from './pricing.js';
import { allTips, dismissTip } from './tips.js';
import { scanDir } from './scanner.js';
import { cachedCatalog } from './skills.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(HERE, '..', 'web');
const PRICING_JSON = path.resolve(HERE, '..', 'pricing.json');

const MAX_POST_BYTES = 1_000_000;
const MAX_LIMIT = 1000;
const DEFAULT_SCAN_INTERVAL = 5;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJson(req, res, obj, status = 200) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  if (req.method === 'HEAD') res.end();
  else res.end(body);
}

function sendError(req, res, status, msg) {
  sendJson(req, res, { error: msg }, status);
}

function sendStatic(req, res, rel) {
  rel = rel.replace(/^\/+/, '');
  const target = path.resolve(WEB_ROOT, rel);
  if (!target.startsWith(path.resolve(WEB_ROOT))) {
    res.writeHead(404).end();
    return;
  }
  let body;
  try {
    body = fs.readFileSync(target);
  } catch {
    res.writeHead(404).end();
    return;
  }
  const ext = path.extname(target).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': body.length,
  });
  if (req.method === 'HEAD') res.end();
  else res.end(body);
}

function clampLimit(raw, dflt) {
  const v = parseInt(raw, 10);
  if (!Number.isFinite(v)) return dflt;
  return Math.max(1, Math.min(v, MAX_LIMIT));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const len = parseInt(req.headers['content-length'] || '0', 10);
    if (!Number.isFinite(len) || len < 0) return reject(new Error('invalid Content-Length'));
    if (len > MAX_POST_BYTES) return reject(new Error(`body too large (max ${MAX_POST_BYTES} bytes)`));
    if (!len) return resolve({});
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > MAX_POST_BYTES) {
        req.destroy();
        reject(new Error('body too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        const obj = text ? JSON.parse(text) : {};
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
          return reject(new Error('body must be a JSON object'));
        }
        resolve(obj);
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function resolveScanInterval() {
  const raw = process.env.TOKEN_DASHBOARD_SCAN_INTERVAL;
  if (!raw) return DEFAULT_SCAN_INTERVAL;
  const v = Number(raw);
  if (!Number.isFinite(v)) return DEFAULT_SCAN_INTERVAL;
  return Math.max(0.5, v);
}

export function buildHandler({ dbPath, projectsDir, subscribers }) {
  const pricing = loadPricing(PRICING_JSON);

  return async function handler(req, res) {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const qs = url.searchParams;
      const since = qs.get('since');
      const until = qs.get('until');
      const p = url.pathname;

      if (req.method === 'GET' || req.method === 'HEAD') {
        if (p === '/' || p === '/index.html') return sendStatic(req, res,'index.html');
        if (p.startsWith('/web/')) return sendStatic(req, res,p.slice(5));

        if (p === '/api/overview') {
          const totals = overviewTotals(dbPath, since, until);
          let costUsd = 0;
          for (const m of modelBreakdown(dbPath, since, until)) {
            const c = costFor(m.model, m, pricing);
            if (c.usd !== null) costUsd += c.usd;
          }
          totals.cost_usd = Math.round(costUsd * 10000) / 10000;
          return sendJson(req, res,totals);
        }
        if (p === '/api/prompts') {
          const limit = clampLimit(qs.get('limit'), 50);
          const sort = qs.get('sort') || 'tokens';
          const rows = expensivePrompts(dbPath, { limit, sort });
          for (const r of rows) {
            const c = costFor(r.model, {
              input_tokens: 0, output_tokens: 0,
              cache_read_tokens: r.cache_read_tokens,
              cache_create_5m_tokens: 0, cache_create_1h_tokens: 0,
            }, pricing);
            r.estimated_cost_usd = c.usd;
          }
          return sendJson(req, res,rows);
        }
        if (p === '/api/projects') return sendJson(req, res,projectSummary(dbPath, since, until));
        if (p === '/api/tools') return sendJson(req, res,toolTokenBreakdown(dbPath, since, until));
        if (p === '/api/sessions') {
          return sendJson(
            req,
            res,
            recentSessions(dbPath, { limit: clampLimit(qs.get('limit'), 20), since, until })
          );
        }
        if (p === '/api/daily') return sendJson(req, res,dailyTokenBreakdown(dbPath, since, until));
        if (p === '/api/skills') {
          const rows = skillBreakdown(dbPath, since, until);
          const catalog = cachedCatalog();
          for (const r of rows) {
            const info = catalog[r.skill];
            r.tokens_per_call = info ? info.tokens : null;
          }
          return sendJson(req, res,rows);
        }
        if (p === '/api/by-model') {
          const rows = modelBreakdown(dbPath, since, until);
          for (const r of rows) {
            const c = costFor(r.model, r, pricing);
            r.cost_usd = c.usd;
            r.cost_estimated = c.estimated;
          }
          return sendJson(req, res,rows);
        }
        if (p.startsWith('/api/sessions/')) {
          const sid = p.split('/').pop();
          return sendJson(req, res,sessionTurns(dbPath, sid));
        }
        if (p === '/api/tips') return sendJson(req, res,allTips(dbPath));
        if (p === '/api/plan') {
          return sendJson(req, res,{ plan: getPlan(dbPath), pricing });
        }
        if (p === '/api/scan') {
          const n = scanDir(projectsDir, dbPath);
          return sendJson(req, res,n);
        }
        if (p === '/api/stream') {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-store',
            Connection: 'keep-alive',
          });
          if (typeof res.flushHeaders === 'function') res.flushHeaders();
          if (req.socket && typeof req.socket.setNoDelay === 'function') req.socket.setNoDelay(true);
          res.write(': hello\n\n');
          subscribers.add(res);
          req.on('close', () => subscribers.delete(res));
          return;
        }

        res.writeHead(404).end();
        return;
      }

      if (req.method === 'POST') {
        let body;
        try {
          body = await readBody(req);
        } catch (err) {
          return sendError(req, res,400, err.message || 'bad request');
        }
        if (p === '/api/plan') {
          setPlan(dbPath, body.plan ?? 'api');
          return sendJson(req, res,{ ok: true });
        }
        if (p === '/api/tips/dismiss') {
          dismissTip(dbPath, body.key ?? '');
          return sendJson(req, res,{ ok: true });
        }
        res.writeHead(404).end();
        return;
      }

      res.writeHead(405).end();
    } catch (err) {
      console.error('[token-dashboard]', req.method, req.url, '\n', (err && err.stack) || err);
      try {
        sendError(req, res,500, err.message || 'internal error');
      } catch { /* ignore */ }
    }
  };
}

export function broadcast(subscribers, evt) {
  const chunk = `data: ${JSON.stringify(evt)}\n\n`;
  for (const res of [...subscribers]) {
    try {
      res.write(chunk);
    } catch {
      subscribers.delete(res);
    }
  }
}

export async function run({ host, port, dbPath, projectsDir }) {
  const subscribers = new Set();
  const handler = buildHandler({ dbPath, projectsDir, subscribers });
  const server = http.createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch(() => {
      try { res.writeHead(500).end(); } catch { /* ignore */ }
    });
  });

  const intervalSec = resolveScanInterval();
  const scanTimer = setInterval(() => {
    try {
      const n = scanDir(projectsDir, dbPath);
      if (n.messages > 0) {
        broadcast(subscribers, { type: 'scan', n, ts: Date.now() / 1000 });
      }
    } catch (err) {
      broadcast(subscribers, { type: 'error', message: String(err.message || err) });
    }
  }, intervalSec * 1000);
  scanTimer.unref?.();

  // SSE keep-alive ping every 15s so proxies don't drop idle streams.
  const pingTimer = setInterval(() => {
    for (const res of [...subscribers]) {
      try { res.write(': ping\n\n'); } catch { subscribers.delete(res); }
    }
  }, 15_000);
  pingTimer.unref?.();

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  return {
    server,
    close: () =>
      new Promise((resolve) => {
        clearInterval(scanTimer);
        clearInterval(pingTimer);
        for (const res of subscribers) { try { res.end(); } catch { /* ignore */ } }
        subscribers.clear();
        server.close(() => resolve());
      }),
  };
}
