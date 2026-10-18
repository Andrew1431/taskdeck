// `taskdeck init` / `taskdeck uninstall`: add or remove the taskdeck MCP server in agent
// clients, so nobody has to get the per-OS command line right by hand.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { HOME } from './home.mjs';
import { stopDaemon } from './client.mjs';

const WIN = process.platform === 'win32';
// Clients spawn the command without a shell, and on Windows npx is a .cmd shim that needs one.
const COMMAND = WIN ? { command: 'cmd', args: ['/c', 'npx', '-y', 'taskdeck@latest', 'mcp'] } : { command: 'npx', args: ['-y', 'taskdeck@latest', 'mcp'] };

function vscodeUserDir() {
  if (WIN) return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Code', 'User');
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Code', 'User');
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'Code', 'User');
}

// claude is a .cmd shim on some Windows installs; every arg here is a plain word, so joining is safe.
const claude = (args) => (WIN ? spawnSync(['claude', ...args].join(' '), { shell: true, encoding: 'utf8' }) : spawnSync('claude', args, { encoding: 'utf8' }));
const claudeResult = (r, ok) => (r.status === 0 ? ok : `failed: ${(r.stderr || r.stdout).trim()}`);

function readJson(file) {
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  // Throws on JSONC comments, which a rewrite would drop; the caller tells the user to edit by hand.
  return text.trim() ? JSON.parse(text) : {};
}

function writeJson(file, value) {
  writeFileSync(`${file}.tmp`, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(`${file}.tmp`, file);
}

// Clients that keep MCP servers in a JSON file under a folder that exists once they're installed.
function jsonClient(id, name, dir, file, key, entry, aliases = []) {
  const path = () => join(dir(), file);
  return {
    id, name, aliases,
    found: () => existsSync(dir()),
    has: () => !!readJson(path())[key]?.taskdeck,
    add() {
      const cfg = readJson(path());
      writeJson(path(), { ...cfg, [key]: { ...cfg[key], taskdeck: entry } });
      return `added to ${path()}`;
    },
    remove() {
      const cfg = readJson(path());
      delete cfg[key].taskdeck;
      writeJson(path(), cfg);
      return `removed from ${path()}`;
    },
    manual: `add "taskdeck": ${JSON.stringify(entry)} under "${key}" in ${path()}`,
  };
}

export const CLIENTS = [
  {
    id: 'claude', name: 'Claude Code', aliases: [],
    found: () => claude(['--version']).status === 0,
    has() {
      try {
        return !!JSON.parse(readFileSync(join(homedir(), '.claude.json'), 'utf8')).mcpServers?.taskdeck;
      } catch {
        return false;
      }
    },
    add: () => claudeResult(claude(['mcp', 'add', 'taskdeck', '--scope', 'user', '--', COMMAND.command, ...COMMAND.args]), 'added'),
    remove: () => claudeResult(claude(['mcp', 'remove', 'taskdeck', '--scope', 'user']), 'removed'),
  },
  jsonClient('vscode', 'VS Code (Copilot)', vscodeUserDir, 'mcp.json', 'servers', { type: 'stdio', ...COMMAND }, ['copilot']),
  jsonClient('cursor', 'Cursor', () => join(homedir(), '.cursor'), 'mcp.json', 'mcpServers', COMMAND),
  jsonClient('windsurf', 'Windsurf', () => join(homedir(), '.codeium', 'windsurf'), 'mcp_config.json', 'mcpServers', COMMAND),
];

// Client ids named by flags (--claude, --copilot...), or null when none were given.
export function pickedClients(flags) {
  const picked = CLIENTS.filter((c) => flags.all || flags[c.id] || c.aliases.some((a) => flags[a]));
  return picked.length ? picked : null;
}

function safely(c, fn) {
  try {
    return fn();
  } catch (e) {
    return `couldn't edit its config (${e.message}); ${c.manual ?? 'edit it by hand'}`;
  }
}

export function init(clients, { dryRun } = {}) {
  return clients.map((c) => {
    if (!c.found()) return `· ${c.name}: not installed`;
    if (safely(c, c.has) === true) return `✓ ${c.name}: already set up`;
    if (dryRun) return `→ ${c.name}: would add taskdeck`;
    const r = safely(c, c.add);
    return `${/^(added|removed)/.test(r) ? '✓' : '✗'} ${c.name}: ${r}`;
  });
}

// Removes taskdeck wherever it's configured (or only from `clients`), then stops the daemon.
export async function uninstall(clients, { dryRun, force, purge } = {}) {
  const out = [];
  for (const c of clients ?? CLIENTS) {
    if (safely(c, c.has) !== true) continue;
    if (dryRun) { out.push(`→ ${c.name}: would remove taskdeck`); continue; }
    const r = safely(c, c.remove);
    out.push(`${/^removed/.test(r) ? '✓' : '✗'} ${c.name}: ${r}`);
  }
  // Removing it from one client leaves the others using the daemon.
  if (clients) return out.length ? out : ['· taskdeck isn\'t set up in those clients'];
  if (dryRun) return [...out, '→ would stop the daemon', ...(purge ? [`→ would delete ${HOME}`] : [])];
  const stopped = await stopDaemon(force);
  if (stopped?.status === 409) return [...out, `✗ daemon: ${stopped.data.running.length} run(s) still going. Stop them, or pass --force to stop them too.`];
  out.push(stopped ? '✓ daemon: stopped' : '· daemon: not running');
  if (purge && existsSync(HOME)) {
    rmSync(HOME, { recursive: true, force: true });
    out.push(`✓ deleted ${HOME} (repo list, run history, proposals)`);
  } else if (existsSync(HOME)) out.push(`· kept ${HOME}; --purge deletes it`);
  out.push('· taskdeck.yaml files in your repos are untouched. If you installed taskdeck globally, also run: npm rm -g taskdeck');
  return out;
}
