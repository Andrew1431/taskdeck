import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, relative, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { action, riskFor } from '../model.mjs';

const PARSER = join(dirname(fileURLToPath(import.meta.url)), 'ps1-parse.ps1');
const SKIP = new Set(['node_modules', '.git', 'bin', 'obj', 'dist', 'Library', 'Temp', '.turbo', '.terraform']);

const TYPES = { int: 'int', int32: 'int', int64: 'int', long: 'int', double: 'number', float: 'number', decimal: 'number', switch: 'bool', bool: 'bool', boolean: 'bool', string: 'string' };

export function detect(root) {
  return findScripts(root, 3).length > 0;
}

export function discover(root) {
  const files = findScripts(root, 3);
  if (!files.length) return { actions: [] };
  const shell = pickShell();
  const json = execFileSync(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', PARSER, '-PathList', files.join('|')], { encoding: 'utf8', maxBuffer: 32 << 20 });
  const parsed = JSON.parse(json);
  const byName = new Map(parsed.map((s) => [basename(s.file).toLowerCase(), s]));

  const actions = parsed.map((s) => {
    const rel = relative(root, s.file).replaceAll('\\', '/');
    const name = basename(rel, '.ps1');
    const folder = dirname(rel);
    const a = action({
      id: `ps1:${rel}`,
      adapter: 'ps1',
      name,
      group: folder === '.' ? '(root)' : folder,
      description: s.synopsis || s.header || null,
      source: { file: rel, line: 1 },
      run: { cwd: '.', command: shell, args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', rel] },
      risk: riskFor(name),
      kind: s.startsProcs ? 'detached' : 'task',
      params: s.params.map(toParam),
      env: s.env.map((name) => ({ name, secret: /token|key|secret|password|pat\b/i.test(name) })),
    });
    if (s.calls.length) a.calls = s.calls.filter((c) => byName.has(c.toLowerCase()));
    if (s.stopsProcs) a.notes.push('Stops running processes.');
    for (const e of s.errors) a.notes.push(`Parse error ${e}`);
    // A switch like -Upload makes that invocation risky, not the action itself.
    for (const p of a.params) if (p.type === 'bool' && /upload|deploy|release|force|delete/i.test(p.name)) p.risk = 'high';
    return a;
  });
  return { shell, actions };
}

function toParam(p) {
  const base = TYPES[p.psType.toLowerCase()] ?? 'string';
  const type = p.choices ? 'enum' : base === 'string' && /(Dir|Directory|Path|Folder|File)$/.test(p.name) ? 'path' : base;
  return {
    name: `-${p.name}`,
    type,
    choices: p.choices ?? undefined,
    default: literal(p.default, type),
    required: p.required,
    description: p.description,
  };
}

// Defaults are source text; only keep the ones that are plain literals.
function literal(text, type) {
  if (text == null) return type === 'bool' ? false : null;
  const s = text.match(/^'([^']*)'$|^"([^"$]*)"$/);
  if (s) return s[1] ?? s[2];
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  if (/^\$(true|false)$/i.test(text)) return /true/i.test(text);
  return { expression: text };
}

function findScripts(dir, depth, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (depth > 0 && !SKIP.has(e.name) && !e.name.startsWith('.')) findScripts(join(dir, e.name), depth - 1, out);
    } else if (e.name.toLowerCase().endsWith('.ps1')) {
      out.push(join(dir, e.name));
    }
  }
  return out;
}

let cachedShell;
function pickShell() {
  if (cachedShell) return cachedShell;
  for (const candidate of ['pwsh', 'powershell']) {
    try {
      execFileSync(candidate, ['-NoProfile', '-Command', 'exit 0'], { stdio: 'ignore' });
      return (cachedShell = candidate);
    } catch {}
  }
  throw new Error('No PowerShell found (pwsh or powershell) to parse .ps1 scripts.');
}
