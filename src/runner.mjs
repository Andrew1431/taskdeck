// Starts actions as child processes, keeps their output on disk and fans it out live.
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { RUNS_DIR, ensureHome } from './home.mjs';

const KEEP_RUNS = 200;
const live = new Map(); // runId -> { child, emitter, meta }

// For showing people: shell-ish quoting that reads naturally.
export function commandLine(argv) {
  return argv.map((a) => (/[\s"'&|<>^%()]/.test(a) ? `"${a.replace(/(\\*)"/g, '$1$1\\"')}"` : a)).join(' ');
}

// For cmd.exe /d /s /c "<this>" on Windows (same approach as cross-spawn): each argument
// gets the backslash-escaping most programs parse (CommandLineToArgvW), then every cmd
// metacharacter, quotes included, is caret-escaped so cmd passes it through untouched.
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;
export function cmdExeLine(argv) {
  const [command, ...args] = argv;
  const escaped = args.map((a) => {
    const quoted = `"${String(a).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
    return quoted.replace(CMD_META, '^$1');
  });
  return [command.replace(CMD_META, '^$1'), ...escaped].join(' ');
}

// Real terminals when node-pty is installed (colors, progress bars, prompts); plain pipes
// otherwise, so `npx taskdeck` still works where the native module can't load.
const require = createRequire(import.meta.url);
const { Terminal: HeadlessTerminal } = require('@xterm/headless');
let pty = null;
try {
  pty = require('node-pty');
} catch {}
export const ptyAvailable = () => !!pty;

const DEFAULT_SIZE = { cols: 120, rows: 30 };

function spawnProc(argv, { cwd, env, cols, rows }) {
  // Through cmd.exe on Windows so .cmd shims (pnpm, npm) resolve; code page 65001 so ✓ survives.
  const winLine = `chcp 65001>nul & ${cmdExeLine(argv)}`;
  if (pty) {
    const ptyEnv = { ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
    delete ptyEnv.FORCE_COLOR;
    delete ptyEnv.NO_COLOR;
    const size = { cols: cols ?? DEFAULT_SIZE.cols, rows: rows ?? DEFAULT_SIZE.rows };
    const term = process.platform === 'win32'
      ? pty.spawn('cmd.exe', `/d /s /c "${winLine}"`, { name: 'xterm-256color', cwd, env: ptyEnv, ...size, useConpty: true })
      : pty.spawn(argv[0], argv.slice(1), { name: 'xterm-256color', cwd, env: ptyEnv, ...size });
    return {
      pty: true,
      pid: term.pid,
      onData: (fn) => term.onData((d) => fn(d, 'stdout')),
      onExit: (fn) => term.onExit(({ exitCode }) => fn(exitCode)),
      write: (d) => term.write(d),
      resize: (c, r) => term.resize(Math.max(20, c), Math.max(5, r)),
    };
  }
  const opts = { cwd, env: { ...env, FORCE_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true };
  const child = process.platform === 'win32'
    ? spawn('cmd.exe', ['/d', '/s', '/c', `"${winLine}"`], { ...opts, windowsVerbatimArguments: true })
    : spawn(argv[0], argv.slice(1), opts);
  return {
    pty: false,
    pid: child.pid,
    onData: (fn) => {
      child.stdout.on('data', (b) => fn(b.toString(), 'stdout'));
      child.stderr.on('data', (b) => fn(b.toString(), 'stderr'));
      child.on('error', (e) => fn(`\n${e.message}\n`, 'stderr'));
    },
    onExit: (fn) => child.on('close', (code) => fn(code ?? 1)),
    write: () => {},
    resize: () => {},
  };
}

/**
 * meta: { repoId, actionId, title, argv, command, cwd, env, by: 'ui'|'agent'|'cli', proposalId?, cols?, rows? }
 * Returns the run record; output streams via subscribe(runId).
 */
export function startRun(meta) {
  ensureHome();
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 6)}`;
  const { cols, rows, ...rest } = meta;
  const record = { id, ...rest, env: Object.keys(meta.env ?? {}), status: 'running', startedAt: Date.now(), endedAt: null, exitCode: null, pid: null, pty: false, cols: cols ?? DEFAULT_SIZE.cols };
  const log = createWriteStream(join(RUNS_DIR, `${id}.log`));
  const emitter = new EventEmitter();
  emitter.setMaxListeners(50);

  let proc;
  try {
    proc = spawnProc(meta.argv, { cwd: meta.cwd, env: { ...process.env, ...meta.env }, cols, rows });
  } catch (e) {
    log.end(`${e.message}\n`);
    return finish({ ...record, status: 'failed', exitCode: -1, error: e.message });
  }
  Object.assign(record, { pid: proc.pid, pty: proc.pty });
  save(record);
  live.set(id, { proc, emitter, record });

  proc.onData((text, stream) => {
    log.write(text);
    emitter.emit('data', { stream, text });
  });
  proc.onExit((code) => {
    log.end();
    const r = live.get(id)?.record ?? record;
    live.delete(id);
    finish({ ...r, status: r.status === 'stopping' ? 'stopped' : code === 0 ? 'succeeded' : 'failed', exitCode: code });
    emitter.emit('end', getRun(id));
  });
  return record;

  function finish(r) {
    r.endedAt = Date.now();
    save(r);
    prune();
    return r;
  }
}

export function writeInput(id, data) {
  const entry = live.get(id);
  if (!entry?.proc.pty) return false;
  entry.proc.write(data);
  return true;
}

export function resizeRun(id, cols, rows) {
  const entry = live.get(id);
  if (!entry) return false;
  entry.proc.resize(cols, rows);
  return true;
}

// Terminal output for readers that aren't terminals (agents): replayed through a headless
// terminal, so progress bars, cursor moves and redraws end up as the text a person would see.
export async function plainText(text, { cols = DEFAULT_SIZE.cols, pty: isPty = true } = {}) {
  const term = new HeadlessTerminal({ cols, rows: DEFAULT_SIZE.rows, scrollback: 100_000, allowProposedApi: true });
  await new Promise((res) => term.write(isPty ? text : text.replace(/\r?\n/g, '\r\n'), res));
  const buf = term.buffer.active;
  const lines = [];
  for (let i = 0; i < buf.length; i++) {
    const line = buf.getLine(i);
    const str = line.translateToString(true);
    if (line.isWrapped && lines.length) lines[lines.length - 1] += str;
    else lines.push(str);
  }
  term.dispose();
  return lines.join('\n').replace(/^\n+/, '').trimEnd();
}

let hasWt;
function windowsTerminal() {
  if (hasWt === undefined) hasWt = spawnSync('where', ['wt'], { windowsHide: true }).status === 0;
  return hasWt;
}

// "Open in my terminal": the user's own terminal window, for when they'd rather work there.
// The command goes in a small script file so no extra layer of quoting gets in the way.
export function openInTerminal({ argv, cwd, env, title }) {
  ensureHome();
  const opts = { cwd, env: { ...process.env, ...env }, detached: true, stdio: 'ignore' };
  const base = join(RUNS_DIR, `terminal-${randomUUID().slice(0, 8)}`);
  if (process.platform === 'win32') {
    const script = `${base}.cmd`;
    // In a .cmd file % expands before carets apply, so it's escaped by doubling instead.
    writeFileSync(script, `@echo off\r\nchcp 65001>nul\r\ncd /d "${cwd}"\r\ntitle ${title.replace(CMD_META, '^$1')}\r\n${cmdExeLine(argv).replaceAll('^%', '%%')}\r\n`);
    if (windowsTerminal()) spawn('wt', ['-w', '0', 'new-tab', '--title', title, '-d', cwd, 'cmd.exe', '/k', script], { ...opts, windowsHide: false }).unref();
    else spawn('cmd.exe', ['/c', 'start', '""', 'cmd.exe', '/k', `"${script}"`], { ...opts, windowsVerbatimArguments: true }).unref();
    return;
  }
  const script = `${base}.sh`;
  const sh = (a) => `'${String(a).replaceAll("'", "'\''")}'`;
  writeFileSync(script, `#!/bin/sh\ncd ${sh(cwd)}\n${argv.map(sh).join(' ')}\nexec "\${SHELL:-sh}"\n`, { mode: 0o755 });
  if (process.platform === 'darwin') spawn('open', ['-a', 'Terminal', script], opts).unref();
  else spawn('x-terminal-emulator', ['-e', script], opts).unref();
}

export function stopRun(id) {
  const entry = live.get(id);
  if (!entry) return false;
  entry.record.status = 'stopping';
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(entry.proc.pid), '/T', '/F'], { windowsHide: true });
  else {
    try {
      process.kill(-entry.proc.pid, 'SIGTERM'); // whole process group (PTY children lead one)
    } catch {
      process.kill(entry.proc.pid, 'SIGTERM');
    }
  }
  return true;
}

export function subscribe(id, onData, onEnd) {
  const entry = live.get(id);
  if (!entry) return null;
  entry.emitter.on('data', onData);
  entry.emitter.once('end', onEnd);
  return () => {
    entry.emitter.off('data', onData);
    entry.emitter.off('end', onEnd);
  };
}

export function getRun(id) {
  const file = join(RUNS_DIR, `${id}.json`);
  if (!/^[\w-]+$/.test(id) || !existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8'));
}

export async function getLog(id, tailBytes, plain) {
  const file = join(RUNS_DIR, `${id}.log`);
  if (!/^[\w-]+$/.test(id) || !existsSync(file)) return '';
  let text = readFileSync(file, 'utf8');
  if (plain) text = await plainText(text, getRun(id) ?? {});
  return tailBytes && text.length > tailBytes ? `…${text.slice(-tailBytes)}` : text;
}

export function listRuns({ repoId, limit = 50 } = {}) {
  ensureHome();
  return readdirSync(RUNS_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .reverse()
    .map((f) => JSON.parse(readFileSync(join(RUNS_DIR, f), 'utf8')))
    .filter((r) => !repoId || r.repoId === repoId)
    .slice(0, limit);
}

// A daemon restart orphans "running" records; mark them so the UI doesn't spin forever.
export function markOrphans() {
  for (const r of listRuns({ limit: KEEP_RUNS })) {
    if (r.status === 'running' || r.status === 'stopping') save({ ...r, status: 'lost', endedAt: r.endedAt ?? Date.now() });
  }
}

function save(r) {
  writeFileSync(join(RUNS_DIR, `${r.id}.json`), JSON.stringify(r, null, 2));
}

function prune() {
  const files = readdirSync(RUNS_DIR);
  for (const f of files.filter((x) => x.startsWith('terminal-'))) {
    const p = join(RUNS_DIR, f);
    if (Date.now() - statSync(p).mtimeMs > 86_400_000) unlinkSync(p);
  }
  const all = files.filter((f) => f.endsWith('.json')).sort();
  for (const f of all.slice(0, Math.max(0, all.length - KEEP_RUNS))) {
    for (const ext of ['.json', '.log']) {
      const p = join(RUNS_DIR, f.replace(/\.json$/, ext));
      if (existsSync(p)) unlinkSync(p);
    }
  }
}
