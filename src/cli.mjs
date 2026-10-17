#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { load, buildInvocation, baseArgv, expandPath } from './contract.mjs';
import { discoverRepo } from './discover.mjs';
import { renderReport } from './report.mjs';
import { api, uiUrl, daemonStatus, stopDaemon } from './client.mjs';
import { openUi } from './open.mjs';

const USAGE = `taskdeck — one contract for every command in a repo

  taskdeck list                       actions in this repo's taskdeck.yaml
  taskdeck show <action>              docs, params and the exact command
  taskdeck run <action> [k=v ...]     run it (--dry-run prints the command, --yes skips confirm)
  taskdeck check                      validate the contract and look for drift
  taskdeck discover [repo...]         draft facts from npm scripts / .ps1 files (for your agent)

  taskdeck ui                         open the UI in its own window (--browser for a normal tab)
  taskdeck add [dir]                  add a repo to the UI (--contract <file> for one kept elsewhere)
  taskdeck status                     is the background daemon running, and what is it doing
  taskdeck stop                       stop the daemon (--force also stops runs still going)
  taskdeck mcp                        MCP server on stdio, for your agent's MCP config
  taskdeck daemon                     run the daemon in the foreground

  --repo <dir>        repo root (default: cwd)
  --contract <file>   contract path (default: <repo>/taskdeck.yaml)
  --json              machine-readable output`;

const { cmd, positional, flags } = parseArgs(process.argv.slice(2));

try {
  await ({ list, show, run, check, discover, ui, add, status, stop, mcp, daemon }[cmd] ?? help)();
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

function help() {
  console.log(USAGE);
  if (cmd && cmd !== 'help') process.exit(2);
}

function ctx() {
  const c = load(flags.repo ?? '.', flags.contract);
  if (c.errors.length && cmd !== 'check') console.error(`warning: contract has ${c.errors.length} problem(s); run \`taskdeck check\``);
  return c;
}

function find(c, id) {
  const a = c.doc.actions.find((x) => x.id === id);
  if (!a) throw new Error(`No action '${id}'. Try: ${c.doc.actions.map((x) => x.id).join(', ')}`);
  return a;
}

function list() {
  const c = ctx();
  if (flags.json) return console.log(JSON.stringify(c.doc, null, 2));
  console.log(`${c.doc.name ?? basename(c.root)}${c.doc.description ? ` — ${firstLine(c.doc.description)}` : ''}\n`);
  const groups = Map.groupBy(c.doc.actions, (a) => a.group);
  for (const [g, actions] of groups) {
    console.log(g);
    for (const a of actions) {
      const tags = [a.risk !== 'low' && `${a.risk} risk`, a.kind !== 'task' && a.kind].filter(Boolean);
      console.log(`  ${a.id.padEnd(22)} ${a.title}${tags.length ? `  [${tags.join(', ')}]` : ''}`);
    }
    console.log();
  }
  const wf = Object.entries(c.doc.workflows);
  if (wf.length) {
    console.log('Workflows');
    for (const [id, w] of wf) console.log(`  ${id.padEnd(22)} ${w.title ?? id} (${w.steps.length} steps)`);
    console.log();
  }
  const cfg = Object.entries(c.doc.configs);
  if (cfg.length) {
    console.log('Config files');
    for (const [id, f] of cfg) console.log(`  ${id.padEnd(22)} ${f.file}${existsSync(resolve(c.root, expandPath(f.file))) ? '' : '  (missing)'}`);
  }
}

function show() {
  const c = ctx();
  const a = find(c, positional[0]);
  if (flags.json) return console.log(JSON.stringify(a, null, 2));
  console.log(`${a.title}  (${a.id})\n`);
  if (a.description) console.log(`${a.description}\n`);
  console.log(`command:  ${baseArgv(a).join(' ')}   (cwd: ${a.cwd})`);
  console.log(`kind: ${a.kind} · risk: ${a.risk} · agent may: ${a.agent}${a.confirm ? ' · asks to confirm' : ''}`);
  if (a.params.length) {
    console.log('\nparams:');
    for (const p of a.params) {
      const how = p.flag ? p.flag : p.option ? `${p.option} <value>` : p.position !== undefined ? `<arg ${p.position}>` : `$${p.env}`;
      const bits = [p.type === 'enum' ? (p.choices ?? []).join('|') : p.type, p.required && 'required', p.default !== undefined && `default ${JSON.stringify(p.default)}`].filter(Boolean);
      console.log(`  ${p.name.padEnd(18)} ${how.padEnd(22)} ${bits.join(', ')}`);
      if (p.description) console.log(`  ${''.padEnd(18)} ${p.description}`);
    }
  }
  for (const r of a.requires) console.log(`requires: ${r}`);
  for (const s of a.secrets) console.log(`secret:   ${s} ${process.env[s] ? '(set)' : '(NOT set)'}`);
}

async function run() {
  const c = ctx();
  const a = find(c, positional[0]);
  const values = Object.fromEntries(positional.slice(1).map((kv) => {
    const i = kv.indexOf('=');
    return i < 0 ? [kv, true] : [kv.slice(0, i), kv.slice(i + 1)];
  }));
  const { argv, env } = buildInvocation(a, values);
  const cwd = resolve(c.root, a.cwd);
  const missing = a.secrets.filter((s) => !process.env[s]);
  console.error(`> ${argv.join(' ')}   (cwd: ${a.cwd})`);
  if (missing.length) console.error(`warning: secrets not set in this environment: ${missing.join(', ')}`);
  if (flags['dry-run']) return;
  if (a.confirm && !flags.yes) {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    const ok = (await rl.question(`${a.title} is ${a.risk} risk. Run it? [y/N] `)).trim().toLowerCase() === 'y';
    rl.close();
    if (!ok) return console.error('Cancelled.');
  }
  const started = Date.now();
  const code = await exec(argv, cwd, env);
  console.error(`\n${a.id} exited ${code} after ${((Date.now() - started) / 1000).toFixed(1)}s`);
  process.exitCode = code;
}

// Windows can't spawn .cmd shims (pnpm, npm) without a shell, so quote for cmd.exe there.
function exec(argv, cwd, env) {
  const win = process.platform === 'win32';
  const child = win
    ? spawn(argv.map(quoteCmd).join(' '), { cwd, env: { ...process.env, ...env }, stdio: 'inherit', shell: true })
    : spawn(argv[0], argv.slice(1), { cwd, env: { ...process.env, ...env }, stdio: 'inherit' });
  return new Promise((res) => child.on('close', (code) => res(code ?? 1)));
}

function quoteCmd(arg) {
  return /[\s"&|<>^%()]/.test(arg) ? `"${arg.replaceAll('"', '""')}"` : arg;
}

function check() {
  const c = ctx();
  const problems = [...c.errors];
  const notes = [];
  for (const a of c.doc.actions) {
    let argv;
    try { argv = baseArgv(a); } catch (e) { problems.push(e.message); continue; }
    for (const x of argv) {
      if (/\.(ps1|sh|mjs|cjs|js|ts|py|bat|cmd)$/.test(x) && !existsSync(resolve(c.root, a.cwd, x))) problems.push(`actions.${a.id}: ${x} not found`);
    }
  }
  for (const [id, f] of Object.entries(c.doc.configs)) {
    if (!existsSync(resolve(c.root, expandPath(f.file)))) {
      notes.push(`configs.${id}: ${f.file} missing${f.example ? ` (copy from ${f.example})` : ''}`);
    }
  }
  // Drift: commands the helpers can see that the contract doesn't mention.
  const known = c.doc.actions.map((a) => { try { return baseArgv(a).join(' '); } catch { return ''; } });
  for (const d of discoverRepo(c.root).actions) {
    const tail = d.adapter === 'npm' ? `run ${d.name}` : d.source.file;
    if (!known.some((k) => k.includes(tail))) notes.push(`not in contract: ${d.id}`);
  }
  for (const p of problems) console.log(`✗ ${p}`);
  for (const n of notes) console.log(`· ${n}`);
  console.log(problems.length ? `\n${problems.length} problem(s).` : `\n✓ ${c.doc.actions.length} actions valid${notes.length ? `, ${notes.length} note(s)` : ''}.`);
  if (problems.length) process.exitCode = 1;
}

function discover() {
  const repos = positional.length ? positional : [flags.repo ?? '.'];
  const catalogs = repos.map((r) => discoverRepo(resolve(r)));
  if (flags.json) return console.log(JSON.stringify(catalogs, null, 2));
  if (flags.out) {
    mkdirSync(flags.out, { recursive: true });
    for (const c of catalogs) writeFileSync(join(flags.out, `${c.repo}.catalog.json`), JSON.stringify(c, null, 2));
  }
  console.log(renderReport(catalogs));
}

async function ui() {
  if (existsSync(join(resolve(flags.repo ?? '.'), 'taskdeck.yaml')) || flags.contract) await add();
  const url = await uiUrl();
  console.log(`taskdeck UI: ${url.replace(/#.*/, '')}`);
  openUi(url, { appMode: !flags.browser });
}

async function add() {
  const dir = positional[0] ?? flags.repo ?? '.';
  const r = await api('POST', '/api/repos', { path: resolve(dir), contract: flags.contract ? resolve(flags.contract) : undefined });
  if (!r.ok) throw new Error(r.data.error);
  console.log(`Added ${r.data.name} (${r.data.actionCount} actions)${r.data.errors.length ? ` with ${r.data.errors.length} contract problem(s)` : ''}`);
}

async function status() {
  const d = await daemonStatus();
  if (flags.json) return console.log(JSON.stringify(d));
  if (!d) return console.log('taskdeck daemon is not running');
  const mins = Math.round(d.uptime / 60);
  console.log(`taskdeck daemon on http://127.0.0.1:${d.port} (pid ${d.pid}), up ${mins < 60 ? `${mins}m` : `${(mins / 60).toFixed(1)}h`}, ${Math.round(d.rss / 1048576)} MB, ${d.running} run(s) going`);
}

async function stop() {
  const r = await stopDaemon(flags.force);
  if (!r) return console.log('taskdeck daemon is not running');
  if (r.status === 409) {
    console.error(`${r.data.running.length} run(s) still going:`);
    for (const x of r.data.running) console.error(`  ${x.title} (${x.id})`);
    console.error('Stop them in the UI, or run `taskdeck stop --force` to stop them with the daemon.');
    process.exitCode = 1; // not exit(): on Windows that can abort while fetch's socket is closing
    return;
  }
  console.log(`Stopped the taskdeck daemon${r.data.stopped ? ` and ${r.data.stopped} run(s)` : ''}`);
}

async function mcp() {
  (await import('./mcp.mjs')).startMcp();
}

async function daemon() {
  const { startDaemon } = await import('./daemon.mjs');
  const { port } = await startDaemon({ port: flags.port ? Number(flags.port) : undefined });
  console.log(`taskdeck daemon on http://127.0.0.1:${port} (pid ${process.pid})`);
}

function parseArgs(args) {
  const flags = {};
  const positional = [];
  const valued = new Set(['repo', 'contract', 'out', 'port']);
  for (let i = 0; i < args.length; i++) {
    const m = args[i].match(/^--([\w-]+)(?:=(.*))?$/);
    if (!m) positional.push(args[i]);
    else flags[m[1]] = m[2] ?? (valued.has(m[1]) ? args[++i] : true);
  }
  return { cmd: positional.shift(), positional, flags };
}

function firstLine(s) {
  return s.trim().split('\n')[0];
}
