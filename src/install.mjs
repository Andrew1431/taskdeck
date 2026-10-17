// `taskdeck init` / `taskdeck uninstall`: add or remove the taskdeck MCP server in each agent
// client found on this machine, so nobody has to get the per-OS command line right by hand.
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

// JSON-config clients: present when their config folder exists.
const JSON_CLIENTS = [
  { name: 'Cursor', dir: () => join(homedir(), '.cursor'), file: 'mcp.json', key: 'mcpServers', entry: COMMAND },
  { name: 'VS Code', dir: vscodeUserDir, file: 'mcp.json', key: 'servers', entry: { type: 'stdio', ...COMMAND } },
  { name: 'Windsurf', dir: () => join(homedir(), '.codeium', 'windsurf'), file: 'mcp_config.json', key: 'mcpServers', entry: COMMAND },
];

// claude is a .cmd shim on some Windows installs; every arg here is a plain word, so joining is safe.
const claude = (args) => (WIN ? spawnSync(['claude', ...args].join(' '), { shell: true, encoding: 'utf8' }) : spawnSync('claude', args, { encoding: 'utf8' }));
const claudeInstalled = () => claude(['--version']).status === 0;
function claudeHas() {
  try {
    return !!JSON.parse(readFileSync(join(homedir(), '.claude.json'), 'utf8')).mcpServers?.taskdeck;
  } catch {
    return false;
  }
}

function readJson(file) {
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  // Throws on JSONC comments, which a rewrite would drop; the caller tells the user to edit by hand.
  return text.trim() ? JSON.parse(text) : {};
}

function writeJson(file, value) {
  writeFileSync(`${file}.tmp`, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(`${file}.tmp`, file);
}

// One line per client: what happened, or what to do by hand.
export function init({ dryRun } = {}) {
  const out = [];
  if (!claudeInstalled()) out.push('· Claude Code: not found');
  else if (claudeHas()) out.push('✓ Claude Code: already set up');
  else if (dryRun) out.push('→ Claude Code: would run claude mcp add taskdeck --scope user');
  else {
    const r = claude(['mcp', 'add', 'taskdeck', '--scope', 'user', '--', COMMAND.command, ...COMMAND.args]);
    out.push(r.status === 0 ? '✓ Claude Code: added' : `✗ Claude Code: ${(r.stderr || r.stdout).trim()}`);
  }
  for (const c of JSON_CLIENTS) {
    const dir = c.dir();
    const file = join(dir, c.file);
    if (!existsSync(dir)) { out.push(`· ${c.name}: not found`); continue; }
    try {
      const cfg = readJson(file);
      if (cfg[c.key]?.taskdeck) { out.push(`✓ ${c.name}: already set up`); continue; }
      if (!dryRun) writeJson(file, { ...cfg, [c.key]: { ...cfg[c.key], taskdeck: c.entry } });
      out.push(`${dryRun ? '→' : '✓'} ${c.name}: ${dryRun ? 'would add to' : 'added to'} ${file}`);
    } catch (e) {
      out.push(`✗ ${c.name}: couldn't read ${file} (${e.message}). Add "taskdeck": ${JSON.stringify(c.entry)} under "${c.key}" yourself.`);
    }
  }
  return out;
}

export async function uninstall({ dryRun, force, purge } = {}) {
  const out = [];
  if (claudeHas()) {
    if (dryRun) out.push('→ Claude Code: would run claude mcp remove taskdeck --scope user');
    else {
      const r = claude(['mcp', 'remove', 'taskdeck', '--scope', 'user']);
      out.push(r.status === 0 ? '✓ Claude Code: removed' : `✗ Claude Code: ${(r.stderr || r.stdout).trim()}`);
    }
  }
  for (const c of JSON_CLIENTS) {
    const file = join(c.dir(), c.file);
    try {
      const cfg = readJson(file);
      if (!cfg[c.key]?.taskdeck) continue;
      if (!dryRun) {
        delete cfg[c.key].taskdeck;
        writeJson(file, cfg);
      }
      out.push(`${dryRun ? '→' : '✓'} ${c.name}: ${dryRun ? 'would remove from' : 'removed from'} ${file}`);
    } catch (e) {
      out.push(`✗ ${c.name}: couldn't read ${file} (${e.message}). Remove "taskdeck" from it yourself.`);
    }
  }
  if (dryRun) {
    out.push('→ would stop the daemon');
    if (purge) out.push(`→ would delete ${HOME}`);
    return out;
  }
  const stopped = await stopDaemon(force);
  if (stopped?.status === 409) {
    out.push(`✗ daemon: ${stopped.data.running.length} run(s) still going. Stop them, or pass --force to stop them too.`);
    return out;
  }
  out.push(stopped ? '✓ daemon: stopped' : '· daemon: not running');
  if (purge && existsSync(HOME)) {
    rmSync(HOME, { recursive: true, force: true });
    out.push(`✓ deleted ${HOME} (repo list, run history, proposals)`);
  } else if (existsSync(HOME)) out.push(`· kept ${HOME}; --purge deletes it`);
  out.push("· taskdeck.yaml files in your repos are untouched. If you installed taskdeck globally, also run: npm rm -g taskdeck");
  return out;
}
