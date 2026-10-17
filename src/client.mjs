// Talks to the local daemon, starting it in the background when it isn't running.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DAEMON_FILE } from './home.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), 'cli.mjs');

function info() {
  if (!existsSync(DAEMON_FILE)) return null;
  try {
    return JSON.parse(readFileSync(DAEMON_FILE, 'utf8'));
  } catch {
    return null;
  }
}

async function healthy(d) {
  try {
    const r = await fetch(`http://127.0.0.1:${d.port}/api/health`, { headers: { 'x-taskdeck-token': d.token }, signal: AbortSignal.timeout(1500) });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

// The running daemon's info and health, or null. Never starts one.
export async function daemonStatus() {
  const d = info();
  const h = d && (await healthy(d));
  return h ? { ...d, ...h } : null;
}

export async function stopDaemon(force) {
  const d = await daemonStatus();
  if (!d) return null;
  const r = await fetch(`http://127.0.0.1:${d.port}/api/shutdown`, {
    method: 'POST',
    headers: { 'x-taskdeck-token': d.token, 'content-type': 'application/json' },
    body: JSON.stringify({ force: !!force }),
  });
  const out = { status: r.status, data: await r.json() };
  // The daemon replies first, then waits for stopped runs to finish before it exits.
  for (let i = 0; r.ok && i < 60 && (await healthy(d)); i++) await new Promise((res) => setTimeout(res, 100));
  return out;
}

export async function ensureDaemon() {
  let d = info();
  if (d && (await healthy(d))) return d;
  spawn(process.execPath, [CLI, 'daemon'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    d = info();
    if (d && (await healthy(d))) return d;
  }
  throw new Error('taskdeck daemon did not start; run `taskdeck daemon` to see why');
}

export async function api(method, path, body) {
  const d = await ensureDaemon();
  const r = await fetch(`http://127.0.0.1:${d.port}${path}`, {
    method,
    headers: { 'x-taskdeck-token': d.token, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await r.json();
  return { ok: r.ok, status: r.status, data };
}

export async function uiUrl() {
  const d = await ensureDaemon();
  return `http://127.0.0.1:${d.port}/#t=${d.token}`;
}
