import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { action } from '../model.mjs';

// Bare `<pm> <name>` runs the package manager's own command instead of the script.
// We always invoke `<pm> run <name>`, but flag these because humans (and AIs) get it wrong.
const BUILTINS = {
  pnpm: ['add', 'audit', 'deploy', 'exec', 'init', 'install', 'link', 'outdated', 'pack', 'publish', 'remove', 'setup', 'store', 'update', 'why'],
  npm: ['audit', 'ci', 'exec', 'init', 'install', 'link', 'outdated', 'pack', 'publish', 'uninstall', 'update', 'version'],
  yarn: ['add', 'init', 'install', 'link', 'pack', 'publish', 'remove', 'upgrade', 'version', 'why'],
  bun: ['add', 'build', 'init', 'install', 'link', 'pm', 'publish', 'remove', 'update', 'x'],
};
const SERVICE = /^(dev|start|serve|watch|preview)(:|$)/;

export function detect(root) {
  return existsSync(join(root, 'package.json'));
}

export function discover(root) {
  const rootPkg = readJson(join(root, 'package.json'));
  const pm = packageManager(root, rootPkg);
  const actions = [];
  for (const dir of [root, ...workspaceDirs(root, rootPkg)]) {
    const pkg = dir === root ? rootPkg : readJson(join(dir, 'package.json'));
    const rel = relative(root, dir).replaceAll('\\', '/') || '.';
    const group = rel === '.' ? '(root)' : pkg.name ?? rel;
    const scripts = pkg.scripts ?? {};
    for (const [name, body] of Object.entries(scripts)) {
      // pre/post hooks run implicitly; they aren't something you'd click.
      const hookOf = name.match(/^(pre|post)(.+)$/)?.[2];
      if (hookOf && scripts[hookOf] !== undefined) continue;

      const a = action({
        id: `npm:${rel}:${name}`,
        adapter: 'npm',
        name,
        group,
        source: { file: `${rel}/package.json`, line: lineOf(join(dir, 'package.json'), `"${name}"`) },
        run: { cwd: rel, command: pm, args: ['run', name] },
        kind: SERVICE.test(name) ? 'service' : 'task',
        script: body,
      });
      if (BUILTINS[pm]?.includes(name)) {
        a.notes.push(`\`${pm} ${name}\` runs ${pm}'s builtin, not this script; use \`${pm} run ${name}\`.`);
      }
      enrichFromEntryFile(a, dir, body);
      delegation(a, body);
      actions.push(a);
    }
  }
  return { packageManager: pm, actions };
}

function packageManager(root, pkg) {
  const declared = pkg.packageManager?.split('@')[0];
  if (declared) return declared;
  if (existsSync(join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(root, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(root, 'bun.lockb')) || existsSync(join(root, 'bun.lock'))) return 'bun';
  return 'npm';
}

function workspaceDirs(root, pkg) {
  let patterns = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces?.packages ?? [];
  const pnpmWs = join(root, 'pnpm-workspace.yaml');
  if (existsSync(pnpmWs)) {
    // Enough YAML for `packages:` followed by `- 'glob'` lines.
    const lines = readFileSync(pnpmWs, 'utf8').split(/\r?\n/);
    const start = lines.findIndex((l) => /^packages:/.test(l));
    if (start >= 0) {
      for (const l of lines.slice(start + 1)) {
        const m = l.match(/^\s*-\s*['"]?([^'"#]+?)['"]?\s*$/);
        if (!m) break;
        patterns.push(m[1]);
      }
    }
  }
  const dirs = [];
  for (const p of patterns) {
    if (p.startsWith('!')) continue;
    const base = p.replace(/\/\*\*?$/, '');
    if (base === p) {
      if (existsSync(join(root, p, 'package.json'))) dirs.push(join(root, p));
      continue;
    }
    const abs = join(root, base);
    if (!existsSync(abs)) continue;
    for (const d of readdirSync(abs)) {
      const full = join(abs, d);
      if (statSync(full).isDirectory() && existsSync(join(full, 'package.json'))) dirs.push(full);
    }
  }
  return dirs;
}

// `node scripts/deploy.mjs` / `tsx src/x.ts`: the entry file's header comment is usually
// the only documentation the script has, and often lists its flags.
function enrichFromEntryFile(a, dir, body) {
  const m = body.match(/^(?:node|tsx|ts-node|bun)\s+(\S+\.(?:m?js|c?js|m?ts))/);
  if (!m) return;
  const file = join(dir, m[1]);
  if (!existsSync(file)) return;
  const src = readFileSync(file, 'utf8');
  const header = leadingComment(src);
  if (header) a.description = header;

  const flags = new Map();
  for (const f of src.matchAll(/args\.includes\(\s*['"](--[\w-]+)['"]\s*\)/g)) flags.set(f[1], null);
  // Flags documented in usage lines: `pnpm run deploy --skip-build   # explanation`
  for (const line of (header ?? '').split('\n')) {
    const u = line.match(/run\s+\S+\s+(.*?)\s+#\s*(.+)$/);
    if (!u) continue;
    for (const f of u[1].matchAll(/(--[\w-]+)/g)) flags.set(f[1], u[2].trim());
  }
  for (const [flag, doc] of flags) {
    a.params.push({ name: flag, type: 'bool', default: false, required: false, description: doc, inferred: true });
  }
  // Positional choices from usage lines: `pnpm run deploy worker   # ...`
  const choices = new Map();
  for (const line of (header ?? '').split('\n')) {
    const u = line.match(new RegExp(`run\\s+${escape(a.name)}\\s+([a-z][\\w-]*)\\s+#\\s*(.+)$`));
    if (u) choices.set(u[1], u[2].trim());
  }
  if (choices.size) {
    a.params.unshift({
      name: 'target', type: 'enum', choices: [...choices.keys()], choiceDocs: Object.fromEntries(choices),
      default: null, required: false, position: 0, inferred: true,
      description: 'Positional; omit for the default.',
    });
  }
}

function delegation(a, body) {
  const filter = body.match(/--filter\s+(\S+)\s+(\w+)(.*)$/);
  if (filter) a.notes.push(`Delegates to \`${filter[2]}\` in workspace package ${filter[1]}${filter[3].trim() ? ` with \`${filter[3].trim()}\`` : ''}.`);
  if (/^turbo\s+run\s/.test(body)) a.notes.push('Fans out across workspace packages via turbo.');
}

function leadingComment(src) {
  const lines = src.replace(/^#!.*\n/, '').split(/\r?\n/);
  const out = [];
  for (const l of lines) {
    const m = l.match(/^\s*\/\/ ?(.*)$/);
    if (!m) break;
    out.push(m[1]);
  }
  const block = src.match(/^\s*\/\*\*?([\s\S]*?)\*\//);
  const text = out.length ? out.join('\n') : block ? block[1].replace(/^[ \t]*\* ?/gm, '') : '';
  return text.trim() || null;
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function lineOf(file, needle) {
  const i = readFileSync(file, 'utf8').split(/\r?\n/).findIndex((l) => l.includes(needle));
  return i < 0 ? null : i + 1;
}

function escape(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

