// One daemon per machine: serves the web UI and the JSON API that the CLI and MCP server use.
// Binds 127.0.0.1 only. Every /api call needs the token from ~/.taskdeck/daemon.json, so a
// web page you happen to visit can't drive it, and the Host check blocks DNS rebinding.
import { createServer } from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import { load, buildInvocation, baseArgv, expandPath, FILE } from './contract.mjs';
import { DAEMON_FILE, ensureHome, readState, writeState } from './home.mjs';
import { startRun, stopRun, subscribe, getRun, getLog, listRuns, markOrphans, openInTerminal, commandLine, cmdExeLine, writeInput, resizeRun, ptyAvailable, liveRuns } from './runner.mjs';

const UI_DIR = join(dirname(fileURLToPath(import.meta.url)), 'ui');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
export const DEFAULT_PORT = 4477;
let shutdown = () => process.exit(0);

export async function startDaemon({ port = DEFAULT_PORT } = {}) {
  ensureHome();
  markOrphans();
  const token = randomBytes(24).toString('hex');
  const server = createServer((req, res) => handle(req, res, token, server.address().port).catch((e) => send(res, 500, { error: e.message })));
  const actualPort = await listen(server, port);
  writeFileSync(DAEMON_FILE, JSON.stringify({ port: actualPort, token, pid: process.pid, startedAt: Date.now() }, null, 2));
  const cleanup = (shutdown = () => {
    try {
      const d = JSON.parse(readFileSync(DAEMON_FILE, 'utf8'));
      if (d.pid === process.pid) unlinkSync(DAEMON_FILE);
    } catch {}
    process.exit(0);
  });
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  return { port: actualPort, token };
}

function listen(server, port, attempts = 10) {
  return new Promise((res, rej) => {
    server.once('error', (e) => {
      if (e.code === 'EADDRINUSE' && attempts > 1) res(listen(server, port + 1, attempts - 1));
      else rej(e);
    });
    server.listen(port, '127.0.0.1', () => res(server.address().port));
  });
}

async function handle(req, res, token, port) {
  const host = (req.headers.host ?? '').toLowerCase();
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return send(res, 403, { error: 'bad host' });
  const url = new URL(req.url, `http://${host}`);
  const path = url.pathname;

  if (!path.startsWith('/api/')) return serveStatic(res, path);
  const given = req.headers['x-taskdeck-token'] ?? url.searchParams.get('t');
  if (given !== token) return send(res, 401, { error: 'missing or wrong token; open the UI with `taskdeck ui`' });

  const body = req.method === 'POST' || req.method === 'DELETE' ? await readBody(req) : {};
  const m = (re) => path.match(re);
  let p;

  if (path === '/api/health') return send(res, 200, { ok: true, pid: process.pid, pty: ptyAvailable(), uptime: Math.round(process.uptime()), running: liveRuns().length, rss: process.memoryUsage().rss });
  if (path === '/api/shutdown' && req.method === 'POST') {
    const running = liveRuns();
    if (running.length && !body.force) return send(res, 409, { error: 'runs still going', running: running.map((r) => ({ id: r.id, title: r.title, repoId: r.repoId })) });
    for (const r of running) stopRun(r.id);
    send(res, 200, { ok: true, stopped: running.length });
    // Give taskkill/SIGTERM a moment so stopped runs get their final status written.
    const deadline = Date.now() + 3000;
    const wait = () => (liveRuns().length && Date.now() < deadline ? setTimeout(wait, 100) : shutdown());
    return wait();
  }

  // ---- repos ----
  if (path === '/api/repos' && req.method === 'GET') return send(res, 200, repos().map(summary));
  if (path === '/api/repos' && req.method === 'POST') return send(res, 200, summary(addRepo(body.path, body.contract)));
  if ((p = m(/^\/api\/repos\/([\w-]+)$/))) {
    const r = repoOr404(p[1], res);
    if (!r) return;
    if (req.method === 'DELETE') {
      const running = liveRuns().filter((x) => x.repoId === r.id);
      if (running.length && !body.force) return send(res, 409, { error: 'runs still going', running: running.map((x) => ({ id: x.id, title: x.title })) });
      for (const x of running) stopRun(x.id);
      writeState('repos', repos().filter((x) => x.id !== r.id));
      const all = proposals();
      for (const prop of all.filter((x) => x.repoId === r.id && x.status === 'pending')) Object.assign(prop, { status: 'dismissed', closedAt: Date.now() });
      writeState('proposals', all);
      return send(res, 200, { ok: true, id: r.id, name: summary(r).name, stopped: running.length });
    }
    return send(res, 200, detail(r));
  }
  if ((p = m(/^\/api\/repos\/([\w-]+)\/actions\/([\w:.-]+)\/(run|preview)$/)) && req.method === 'POST') {
    const r = repoOr404(p[1], res);
    if (!r) return;
    const out = runAction(r, p[2], body.values ?? {}, { by: body.by ?? 'ui', confirmed: body.confirmed, preview: p[3] === 'preview', proposalId: body.proposalId, terminal: body.terminal, cols: body.cols, rows: body.rows });
    return send(res, out.status ?? 200, out.body);
  }
  if ((p = m(/^\/api\/repos\/([\w-]+)\/actions\/([\w:.-]+)\/choices\/([\w-]+)$/))) {
    const r = repoOr404(p[1], res);
    if (!r) return;
    return send(res, 200, await choices(r, p[2], p[3]));
  }
  if ((p = m(/^\/api\/repos\/([\w-]+)\/open$/)) && req.method === 'POST') {
    const r = repoOr404(p[1], res);
    if (!r) return;
    return send(res, ...openFile(r, body.file));
  }

  // ---- folder picker ----
  if (path === '/api/fs') return send(res, 200, listDir(url.searchParams.get('path'), url.searchParams.has('files')));

  // ---- runs ----
  if (path === '/api/runs' && url.searchParams.has('live')) return send(res, 200, liveRuns().map((r) => ({ id: r.id, repoId: r.repoId, title: r.title })));
  if (path === '/api/runs') return send(res, 200, listRuns({ repoId: url.searchParams.get('repo'), limit: Number(url.searchParams.get('limit') ?? 50) }));
  if ((p = m(/^\/api\/runs\/([\w-]+)$/))) {
    const run = getRun(p[1]);
    if (!run) return send(res, 404, { error: 'no such run' });
    return send(res, 200, { ...run, log: await getLog(p[1], Number(url.searchParams.get('tail') ?? 0) || undefined, url.searchParams.has('plain')) });
  }
  if ((p = m(/^\/api\/runs\/([\w-]+)\/stop$/)) && req.method === 'POST') return send(res, 200, { stopped: stopRun(p[1]) });
  if ((p = m(/^\/api\/runs\/([\w-]+)\/input$/)) && req.method === 'POST') return send(res, 200, { written: writeInput(p[1], String(body.data ?? '')) });
  if ((p = m(/^\/api\/runs\/([\w-]+)\/resize$/)) && req.method === 'POST') return send(res, 200, { resized: resizeRun(p[1], Number(body.cols), Number(body.rows)) });
  if ((p = m(/^\/api\/runs\/([\w-]+)\/stream$/))) return stream(req, res, p[1]);

  // ---- proposals ----
  if (path === '/api/proposals' && req.method === 'GET') return send(res, 200, proposals().filter((x) => url.searchParams.get('all') || x.status === 'pending'));
  if (path === '/api/proposals' && req.method === 'POST') {
    const out = propose(body);
    return send(res, out.status ?? 200, out.body);
  }
  if ((p = m(/^\/api\/proposals\/([\w-]+)\/(dismiss|ran)$/)) && req.method === 'POST') {
    const all = proposals();
    const prop = all.find((x) => x.id === p[1]);
    if (!prop) return send(res, 404, { error: 'no such proposal' });
    prop.status = p[2] === 'dismiss' ? 'dismissed' : 'ran';
    if (body.runId) prop.runId = body.runId;
    prop.closedAt = Date.now();
    writeState('proposals', all);
    return send(res, 200, prop);
  }

  send(res, 404, { error: `no route ${req.method} ${path}` });
}

// ---------- repos ----------

function repos() {
  return readState('repos', []);
}

export function addRepo(path, contract) {
  if (!path) throw new Error('path required');
  const root = resolve(path);
  if (!existsSync(root)) throw new Error(`${root} does not exist`);
  const all = repos();
  const existing = all.find((r) => r.path.toLowerCase() === root.toLowerCase());
  if (existing) {
    if (contract) existing.contract = resolve(contract);
    writeState('repos', all);
    return existing;
  }
  let id = basename(root).toLowerCase().replace(/[^\w-]+/g, '-');
  while (all.some((r) => r.id === id)) id += '-2';
  const entry = { id, path: root, contract: contract ? resolve(contract) : null, addedAt: Date.now() };
  writeState('repos', [...all, entry]);
  return entry;
}

function repoOr404(id, res) {
  const r = repos().find((x) => x.id === id);
  if (!r) send(res, 404, { error: `no repo '${id}'` });
  return r;
}

function loadRepo(r) {
  try {
    return load(r.path, r.contract);
  } catch (e) {
    return { root: r.path, file: r.contract ?? join(r.path, FILE), doc: null, errors: [e.message] };
  }
}

function summary(r) {
  const c = loadRepo(r);
  return { id: r.id, path: r.path, name: c.doc?.name ?? basename(r.path), contractFile: c.file, hasContract: !!c.doc, actionCount: c.doc?.actions.length ?? 0, errors: c.errors };
}

function detail(r) {
  const c = loadRepo(r);
  if (!c.doc) return { ...summary(r), actions: [], workflows: {}, configs: {} };
  const actions = c.doc.actions.map((a) => {
    let command = null;
    try { command = commandLine(baseArgv(a)); } catch {}
    return { ...a, command, secretsSet: Object.fromEntries(a.secrets.map((s) => [s, !!process.env[s]])) };
  });
  const configs = Object.fromEntries(Object.entries(c.doc.configs).map(([id, f]) => {
    const abs = resolve(c.root, expandPath(f.file));
    return [id, { ...f, exists: existsSync(abs), exampleExists: f.example ? existsSync(resolve(c.root, f.example)) : null }];
  }));
  return { ...summary(r), description: c.doc.description ?? null, actions, workflows: c.doc.workflows, configs };
}

// ---------- running ----------

export function runAction(r, actionId, values, { by, confirmed, preview, proposalId, terminal, cols, rows }) {
  const c = loadRepo(r);
  const a = c.doc?.actions.find((x) => x.id === actionId);
  if (!a) return { status: 404, body: { error: `no action '${actionId}' in ${r.id}` } };
  let inv;
  try {
    inv = buildInvocation(a, values);
  } catch (e) {
    return { status: 400, body: { error: e.message } };
  }
  const cwd = resolve(c.root, a.cwd);
  const command = commandLine(inv.argv);
  if (preview) return { body: { command, cwd: a.cwd, kind: a.kind, risk: a.risk, confirm: a.confirm } };

  if (by === 'agent' && a.kind === 'interactive') {
    return { status: 403, body: { error: `'${actionId}' is interactive (needs someone typing).`, policy: 'propose', command } };
  }
  if (by === 'agent' && (a.agent !== 'run' || a.confirm)) {
    return { status: 403, body: { error: `'${actionId}' is ${a.agent === 'never' ? 'human-only' : 'propose-only'} for agents (risk: ${a.risk}).`, policy: a.agent, command } };
  }
  if (by !== 'agent' && a.confirm && !confirmed) {
    return { status: 409, body: { error: 'needs confirmation', command, risk: a.risk } };
  }
  const meta = { repoId: r.id, actionId, title: a.title, argv: inv.argv, command, cwd, env: inv.env, by, proposalId, cols, rows };
  // Interactive actions need a real terminal: ours when node-pty loaded, else the user's.
  if (terminal || (a.kind === 'interactive' && !ptyAvailable())) {
    openInTerminal({ ...meta, title: a.title });
    return { body: { terminal: true, command } };
  }
  const run = startRun(meta);
  if (proposalId) closeProposal(proposalId, run.id);
  return { body: run };
}

async function stream(req, res, id) {
  const run = getRun(id);
  if (!run) return send(res, 404, { error: 'no such run' });
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const sse = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  sse('log', { stream: 'stdout', text: await getLog(id) });
  const unsubscribe = subscribe(id, (d) => sse('log', d), (r) => { sse('end', r); res.end(); });
  if (!unsubscribe) {
    sse('end', getRun(id));
    return res.end();
  }
  req.on('close', unsubscribe);
}

async function choices(r, actionId, paramName) {
  const c = loadRepo(r);
  const a = c.doc?.actions.find((x) => x.id === actionId);
  const p = a?.params.find((x) => x.name === paramName);
  if (!p?.choicesFrom) return { choices: p?.choices ?? [] };
  const argv = typeof p.choicesFrom.run === 'string' ? p.choicesFrom.run.split(/\s+/) : p.choicesFrom.run;
  const stdout = await new Promise((res) => {
    execFile(process.platform === 'win32' ? 'cmd.exe' : argv[0], process.platform === 'win32' ? ['/d', '/s', '/c', `"${cmdExeLine(argv)}"`] : argv.slice(1),
      { cwd: resolve(c.root, a.cwd), timeout: 30_000, windowsHide: true, windowsVerbatimArguments: true }, (err, out) => res(err ? '' : out));
  });
  const re = new RegExp(p.choicesFrom.pattern ?? '^(\\S+)');
  const found = stdout.split(/\r?\n/).map((l) => l.match(re)?.[1]).filter(Boolean);
  return { choices: [...new Set(found)] };
}

function openFile(r, file) {
  const c = loadRepo(r);
  if (!c.doc) return [404, { error: 'no contract' }];
  // Only files the contract names: configs and workflow edit steps.
  const allowed = new Set([
    ...Object.values(c.doc.configs).flatMap((f) => [f.file, f.example].filter(Boolean)),
    ...Object.values(c.doc.workflows).flatMap((w) => (w.steps ?? []).map((s) => s.edit).filter(Boolean)),
    basename(c.file) === FILE ? FILE : null,
  ].filter(Boolean));
  if (!allowed.has(file)) return [403, { error: `${file} is not a config or edit step in the contract` }];
  const abs = resolve(c.root, expandPath(file));
  if (!existsSync(abs)) return [404, { error: `${abs} does not exist` }];
  const editor = process.env.TASKDECK_EDITOR;
  if (editor) spawn(editor, [abs], { detached: true, stdio: 'ignore', shell: process.platform === 'win32' }).unref();
  else if (process.platform === 'win32') spawn('cmd.exe', ['/c', 'start', '""', `"${abs}"`], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true }).unref();
  else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [abs], { detached: true, stdio: 'ignore' }).unref();
  return [200, { opened: abs }];
}

// ---------- proposals ----------

function proposals() {
  return readState('proposals', []);
}

function propose({ repoId, actionId, values = {}, reason, by = 'agent' }) {
  const r = repos().find((x) => x.id === repoId);
  if (!r) return { status: 404, body: { error: `no repo '${repoId}'` } };
  const c = loadRepo(r);
  const a = c.doc?.actions.find((x) => x.id === actionId);
  if (!a) return { status: 404, body: { error: `no action '${actionId}'` } };
  let command;
  try {
    command = commandLine(buildInvocation(a, values).argv);
  } catch (e) {
    return { status: 400, body: { error: e.message } };
  }
  const prop = { id: randomUUID().slice(0, 8), repoId, actionId, title: a.title, risk: a.risk, values, command, reason: reason ?? null, by, status: 'pending', createdAt: Date.now() };
  writeState('proposals', [...proposals(), prop].slice(-500));
  return { body: prop };
}

function closeProposal(id, runId) {
  const all = proposals();
  const prop = all.find((x) => x.id === id);
  if (!prop) return;
  Object.assign(prop, { status: 'ran', runId, closedAt: Date.now() });
  writeState('proposals', all);
}

// ---------- http helpers ----------

// Browser builds of xterm.js, served straight from node_modules (no bundler).
const require = createRequire(import.meta.url);
const VENDOR = {
  '/vendor/xterm.js': () => require.resolve('@xterm/xterm/lib/xterm.js'),
  '/vendor/xterm.css': () => join(dirname(require.resolve('@xterm/xterm/lib/xterm.js')), '../css/xterm.css'),
  '/vendor/addon-fit.js': () => require.resolve('@xterm/addon-fit/lib/addon-fit.js'),
};

// The browser can't hand us a real folder path, so the UI browses through the daemon.
// `files`: also list contract-looking files, for picking a contract that lives elsewhere.
function listDir(dir, files) {
  const roots = process.platform === 'win32'
    ? [...'CDEFGHIJKLMNOPQRSTUVWXYZ'].map((l) => `${l}:\\`).filter((d) => existsSync(d))
    : ['/'];
  const at = resolve(dir || homedir());
  let entries = [];
  try {
    entries = readdirSync(at, { withFileTypes: true });
  } catch (e) {
    return { path: at, parent: dirname(at) === at ? null : dirname(at), roots, home: homedir(), error: e.code === 'EPERM' || e.code === 'EACCES' ? 'No permission to open this folder' : e.message, dirs: [], files: [] };
  }
  const has = (d, name) => existsSync(join(at, d, name));
  const dirs = entries.filter((e) => e.isDirectory() && !['.git', 'node_modules', '$RECYCLE.BIN', 'System Volume Information'].includes(e.name))
    .map((e) => ({ name: e.name, contract: has(e.name, FILE), git: has(e.name, '.git') }))
    .sort((a, b) => a.name.startsWith('.') - b.name.startsWith('.') || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  const yaml = files ? entries.filter((e) => e.isFile() && /\.ya?ml$/i.test(e.name)).map((e) => e.name).sort() : [];
  return { path: at, parent: dirname(at) === at ? null : dirname(at), roots, home: homedir(), contract: existsSync(join(at, FILE)), dirs, files: yaml };
}

function serveStatic(res, path) {
  const file = VENDOR[path] ? VENDOR[path]() : resolve(UI_DIR, `.${path === '/' ? '/index.html' : path}`);
  if ((!VENDOR[path] && !file.startsWith(UI_DIR)) || !existsSync(file)) return send(res, 404, { error: 'not found' });
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
  res.end(readFileSync(file));
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((res, rej) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1 << 20) rej(new Error('body too large'));
    });
    req.on('end', () => {
      try { res(data ? JSON.parse(data) : {}); } catch { rej(new Error('invalid JSON body')); }
    });
  });
}
