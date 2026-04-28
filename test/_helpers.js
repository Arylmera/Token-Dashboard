import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function makeTmpDir(prefix = 'token-dash-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}
