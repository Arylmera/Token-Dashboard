#!/usr/bin/env node
import { initDb, overviewTotals } from './src/db.js';
import { resolveDbPath, resolveProjectsDir } from './src/paths.js';

function todayRange() {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString();
  return [start, tomorrow];
}

function fmt(n) {
  return Number(n || 0).toLocaleString('en-US').padStart(12);
}

function parseArgs(argv) {
  const args = { _: [], db: null, projectsDir: null, noScan: false, noOpen: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--db') args.db = argv[++i];
    else if (a === '--projects-dir') args.projectsDir = argv[++i];
    else if (a === '--no-scan') args.noScan = true;
    else if (a === '--no-open') args.noOpen = true;
    else if (a === '-h' || a === '--help') args.help = true;
    else args._.push(a);
  }
  return args;
}

function help() {
  console.log(`Usage: token-dashboard <command> [options]

Commands:
  scan        Scan Claude Code transcripts into the database
  today       Print today's usage totals
  stats       Print all-time usage totals
  tips        Print actionable suggestions
  dashboard   Start the local web dashboard

Options:
  --db PATH               SQLite path (default ~/.claude/token-dashboard.db)
  --projects-dir PATH     JSONL root (default ~/.claude/projects)
  --no-scan               (dashboard) skip the initial scan
  --no-open               (dashboard) do not open the browser
`);
}

async function cmdScan(args) {
  const db = resolveDbPath(args.db);
  initDb(db);
  const { scanDir } = await import('./src/scanner.js');
  const n = scanDir(resolveProjectsDir(args.projectsDir), db);
  console.log(`Token Dashboard: scanned ${n.files} files, ${n.messages} messages, ${n.tools} tool calls`);
}

function cmdToday(args) {
  const db = resolveDbPath(args.db);
  initDb(db);
  const [s, e] = todayRange();
  const t = overviewTotals(db, s, e);
  console.log('Token Dashboard — today');
  console.log(`  sessions: ${t.sessions}    turns: ${t.turns}`);
  console.log(`  input:    ${fmt(t.input_tokens)}    output: ${fmt(t.output_tokens)}`);
  console.log(`  cache rd: ${fmt(t.cache_read_tokens)}    cache cr: ${fmt((t.cache_create_5m_tokens || 0) + (t.cache_create_1h_tokens || 0))}`);
}

function cmdStats(args) {
  const db = resolveDbPath(args.db);
  initDb(db);
  const t = overviewTotals(db);
  console.log('Token Dashboard — all time');
  console.log(`  sessions: ${t.sessions}    turns: ${t.turns}`);
  console.log(`  input:    ${fmt(t.input_tokens)}    output: ${fmt(t.output_tokens)}`);
}

async function cmdTips(args) {
  const db = resolveDbPath(args.db);
  initDb(db);
  const { allTips } = await import('./src/tips.js');
  const tips = allTips(db);
  if (!tips.length) {
    console.log('Token Dashboard: no suggestions');
    return;
  }
  for (const tip of tips) {
    console.log(`[${tip.category}] ${tip.title}`);
    console.log(`  ${tip.body}\n`);
  }
}

async function cmdDashboard(args) {
  const db = resolveDbPath(args.db);
  const projects = resolveProjectsDir(args.projectsDir);
  initDb(db);
  if (!args.noScan) {
    const { scanDir } = await import('./src/scanner.js');
    scanDir(projects, db);
  }
  const { run } = await import('./src/server.js');
  const host = process.env.HOST || '127.0.0.1';
  const port = Number(process.env.PORT || 8080);
  await run({ host, port, dbPath: db, projectsDir: projects });
  const url = `http://${host}:${port}/`;
  console.log(`Token Dashboard listening on ${url}`);
  if (!args.noOpen) {
    const opener = process.platform === 'darwin' ? 'open'
                 : process.platform === 'win32' ? 'start'
                 : 'xdg-open';
    const { spawn } = await import('node:child_process');
    try {
      spawn(opener, [url], { detached: true, stdio: 'ignore', shell: process.platform === 'win32' }).unref();
    } catch { /* ignore */ }
  }
}

const COMMANDS = {
  scan: cmdScan,
  today: cmdToday,
  stats: cmdStats,
  tips: cmdTips,
  dashboard: cmdDashboard,
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args._.length) {
    help();
    process.exit(args.help ? 0 : 1);
  }
  const fn = COMMANDS[args._[0]];
  if (!fn) {
    console.error(`Unknown command: ${args._[0]}`);
    help();
    process.exit(1);
  }
  await fn(args);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
