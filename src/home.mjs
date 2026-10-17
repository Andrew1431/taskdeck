// Global state under ~/.taskdeck (override with TASKDECK_HOME): registered repos, run logs,
// proposals, and the running daemon's port + token.
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const HOME = process.env.TASKDECK_HOME ?? join(homedir(), '.taskdeck');
export const RUNS_DIR = join(HOME, 'runs');
export const DAEMON_FILE = join(HOME, 'daemon.json');

export function ensureHome() {
  mkdirSync(RUNS_DIR, { recursive: true });
}

export function readState(name, fallback) {
  const file = join(HOME, `${name}.json`);
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// Write-then-rename so a crash never leaves half a file.
export function writeState(name, value) {
  ensureHome();
  const file = join(HOME, `${name}.json`);
  writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2));
  renameSync(`${file}.tmp`, file);
}
