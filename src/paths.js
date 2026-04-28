import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function defaultDbPath() {
  return path.join(os.homedir(), '.claude', 'token-dashboard.db');
}

export function defaultProjectsDir() {
  return path.join(os.homedir(), '.claude', 'projects');
}

export function resolveDbPath(cliArg) {
  return cliArg || process.env.TOKEN_DASHBOARD_DB || defaultDbPath();
}

export function resolveProjectsDir(cliArg) {
  return cliArg || process.env.CLAUDE_PROJECTS_DIR || defaultProjectsDir();
}

export function repoRoot() {
  return path.resolve(fileURLToPath(new URL('..', import.meta.url)));
}
