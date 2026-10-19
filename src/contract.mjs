// The contract: taskdeck.yaml at a repo root. Runner-agnostic: an action is an argv plus typed
// params that map onto it, so anything you can type in a terminal fits. See CONTRACT.md.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';

export const FILE = 'taskdeck.yaml';
const TYPES = ['string', 'int', 'number', 'bool', 'enum', 'path', 'list'];
const KINDS = ['task', 'service', 'detached', 'interactive'];
const RISKS = ['low', 'medium', 'high'];
const AGENT = ['run', 'propose', 'never'];
const ACTION_KEYS = ['title', 'description', 'group', 'run', 'cwd', 'kind', 'risk', 'confirm', 'agent', 'env', 'secrets', 'requires', 'params'];
const LINK_KEYS = ['title', 'url', 'group', 'description'];
const GROUP_KEYS = ['description', 'health'];
const PARAM_KEYS = ['type', 'description', 'default', 'required', 'choices', 'choicesFrom', 'flag', 'option', 'position', 'env', 'secret'];

export function load(repo, contractPath) {
  const root = resolve(repo);
  const file = contractPath ? resolve(contractPath) : join(root, FILE);
  if (!existsSync(file)) throw new Error(`No contract at ${file}. Point your agent at AGENT_SETUP.md to write one.`);
  const raw = parse(readFileSync(file, 'utf8')) ?? {};
  const errors = [];
  const doc = { ...raw };
  for (const k of ['actions', 'links', 'groups']) doc[k] = expandEach(raw[k], k, errors);
  errors.push(...validate(doc));
  return { root, file, doc: normalize(doc), errors };
}

function normalize(doc) {
  const actions = Object.entries(doc.actions ?? {}).map(([id, a]) => {
    const risk = a.risk ?? 'low';
    return {
      id,
      title: a.title ?? id,
      group: a.group ?? 'General',
      description: a.description?.trim() ?? null,
      run: a.run,
      cwd: a.cwd ?? '.',
      kind: a.kind ?? 'task',
      risk,
      confirm: a.confirm ?? risk === 'high',
      agent: a.agent ?? (risk === 'high' ? 'propose' : 'run'),
      env: a.env ?? [],
      secrets: a.secrets ?? [],
      requires: a.requires ?? [],
      params: Object.entries(a.params ?? {}).map(([name, p]) => ({ name, type: p.type ?? (p.flag ? 'bool' : 'string'), ...p })),
    };
  });
  const links = Object.entries(doc.links ?? {}).map(([id, l]) => ({ id, title: l.title ?? id, url: l.url, group: l.group ?? null, description: l.description?.trim() ?? null }));
  const groups = Object.fromEntries(Object.entries(doc.groups ?? {}).map(([name, g]) => [name, { description: g.description?.trim() ?? null, health: normalizeHealth(g.health) }]));
  return { ...doc, actions, links, groups, configs: doc.configs ?? {}, workflows: doc.workflows ?? {} };
}

// health: a URL, { url }, or { run, cwd? }; a URL is up when it answers below 500, a command when it exits 0.
function normalizeHealth(h) {
  if (!h) return null;
  if (typeof h === 'string') return { url: h };
  return h.url ? { url: h.url } : { run: h.run, cwd: h.cwd ?? '.' };
}

// `each: { service: [web, api] }` on an action, link or group repeats it once per value (the
// cross product for several keys), with {service} replaced in its id and every string inside it.
function expandEach(section, at, errors) {
  if (!section || typeof section !== 'object') return section;
  const out = {};
  for (const [id, item] of Object.entries(section)) {
    if (!item?.each) {
      out[id] = item;
      continue;
    }
    const { each, ...rest } = item;
    const keys = typeof each === 'object' && !Array.isArray(each) ? Object.keys(each) : [];
    const bad = !keys.length || keys.some((k) => !Array.isArray(each[k]) || each[k].some((v) => typeof v !== 'string' && typeof v !== 'number'));
    if (bad) {
      errors.push(`${at}.${id}.each: must be a map of name: [values], e.g. { service: [web, api] }`);
      continue;
    }
    const missing = keys.filter((k) => !id.includes(`{${k}}`));
    if (missing.length) {
      errors.push(`${at}.${id}: id must include ${missing.map((k) => `{${k}}`).join(' and ')} so each copy gets its own id`);
      continue;
    }
    let combos = [{}];
    for (const k of keys) combos = combos.flatMap((c) => each[k].map((v) => ({ ...c, [k]: String(v) })));
    for (const vars of combos) {
      const sub = (v) => typeof v === 'string' ? v.replace(/\{(\w+)\}/g, (m, k) => vars[k] ?? m)
        : Array.isArray(v) ? v.map(sub)
        : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [sub(k), sub(x)]))
        : v;
      const newId = sub(id);
      if (newId in out || newId in section) errors.push(`${at}.${id}: expands to '${newId}', which already exists`);
      out[newId] = sub(rest);
    }
  }
  return out;
}

export function validate(doc) {
  const errors = [];
  const err = (path, msg) => errors.push(`${path}: ${msg}`);
  if (doc.version !== 1) err('version', 'must be 1');
  const ids = new Set(Object.keys(doc.actions ?? {}));
  for (const [id, a] of Object.entries(doc.actions ?? {})) {
    const at = `actions.${id}`;
    // Unknown keys are usually YAML mistakes, e.g. an unquoted comma in a { flow: map }.
    for (const k of Object.keys(a)) if (!ACTION_KEYS.includes(k)) err(at, `unknown key '${k}'`);
    if (!a.run) err(at, 'missing `run`');
    else if (!isArgv(a.run) && !(typeof a.run === 'object' && Object.values(a.run).every(isArgv))) {
      err(`${at}.run`, 'must be a string, an argv list, or { windows|macos|linux|default: argv }');
    }
    if (a.kind && !KINDS.includes(a.kind)) err(`${at}.kind`, `one of ${KINDS.join('|')}`);
    if (a.risk && !RISKS.includes(a.risk)) err(`${at}.risk`, `one of ${RISKS.join('|')}`);
    if (a.agent && !AGENT.includes(a.agent)) err(`${at}.agent`, `one of ${AGENT.join('|')}`);
    const positions = new Set();
    for (const [name, p] of Object.entries(a.params ?? {})) {
      const pp = `${at}.params.${name}`;
      const type = p.type ?? (p.flag ? 'bool' : 'string');
      for (const k of Object.keys(p)) if (!PARAM_KEYS.includes(k)) err(pp, `unknown key '${k}' (unquoted comma?)`);
      if (!TYPES.includes(type)) err(`${pp}.type`, `one of ${TYPES.join('|')}`);
      const roles = ['flag', 'option', 'position', 'env'].filter((r) => p[r] !== undefined);
      if (roles.length !== 1) err(pp, 'needs exactly one of flag | option | position | env (how the value reaches the command)');
      if (p.flag !== undefined && type !== 'bool') err(pp, '`flag` only fits type bool');
      if (type === 'enum' && !p.choices && !p.choicesFrom) err(pp, 'enum needs `choices` or `choicesFrom`');
      if (p.position !== undefined) {
        if (positions.has(p.position)) err(pp, `duplicate position ${p.position}`);
        positions.add(p.position);
      }
    }
  }
  for (const [id, w] of Object.entries(doc.workflows ?? {})) {
    (w.steps ?? []).forEach((s, i) => {
      const kinds = ['action', 'manual', 'edit'].filter((k) => s[k] !== undefined);
      if (kinds.length !== 1) err(`workflows.${id}.steps[${i}]`, 'needs exactly one of action | manual | edit');
      if (s.action && !ids.has(s.action)) err(`workflows.${id}.steps[${i}]`, `unknown action '${s.action}'`);
    });
  }
  for (const [id, c] of Object.entries(doc.configs ?? {})) {
    if (!c.file) err(`configs.${id}`, 'missing `file`');
  }
  for (const [id, l] of Object.entries(doc.links ?? {})) {
    for (const k of Object.keys(l ?? {})) if (!LINK_KEYS.includes(k)) err(`links.${id}`, `unknown key '${k}'`);
    if (!/^https?:\/\//.test(l?.url ?? '')) err(`links.${id}.url`, 'must be an http:// or https:// URL');
  }
  for (const [name, g] of Object.entries(doc.groups ?? {})) {
    for (const k of Object.keys(g ?? {})) if (!GROUP_KEYS.includes(k)) err(`groups.${name}`, `unknown key '${k}'`);
    const hl = g?.health;
    if (hl !== undefined) {
      const url = typeof hl === 'string' ? hl : hl?.url;
      if (url !== undefined ? !/^https?:\/\//.test(url) : !isArgv(hl?.run)) err(`groups.${name}.health`, 'a URL, { url }, or { run: command, cwd? }');
    }
  }
  if (doc.generatedBy !== undefined && typeof doc.generatedBy?.tool !== 'string') err('generatedBy', 'needs `tool` (and optionally `regenerate`: the command that rewrites this file)');
  return errors;
}

// Config paths may point outside the repo: %APPDATA%, $HOME, ~.
export function expandPath(p) {
  return p
    .replace(/%([^%]+)%/g, (m, k) => process.env[k] ?? m)
    .replace(/\$\{?(\w+)\}?/g, (m, k) => process.env[k] ?? m)
    .replace(/^~(?=[\/]|$)/, process.env.HOME ?? process.env.USERPROFILE ?? '~');
}

function isArgv(v) {
  return typeof v === 'string' || (Array.isArray(v) && v.every((x) => typeof x === 'string'));
}

const PLATFORM = { win32: 'windows', darwin: 'macos', linux: 'linux' }[process.platform] ?? 'default';

export function baseArgv(action) {
  let run = action.run;
  if (!isArgv(run)) run = run[PLATFORM] ?? run.default;
  if (!run) throw new Error(`${action.id} has no command for ${PLATFORM}`);
  return typeof run === 'string' ? splitArgs(run) : [...run];
}

// values: { paramName: raw string | boolean }. Returns { argv, env } or throws with every problem.
export function buildInvocation(action, values) {
  const problems = [];
  const argv = baseArgv(action);
  const positional = [];
  const tail = [];
  const env = {};
  for (const p of action.params) {
    // `default` documents what the command does when the param is omitted (and pre-fills
    // the UI); it is never passed, so the script's own default stays the source of truth.
    let v = values[p.name];
    if (v === undefined || v === null || v === '') {
      if (p.required) problems.push(`${p.name} is required`);
      continue;
    }
    v = coerce(p, v, problems);
    if (v === undefined) continue;
    if (p.flag !== undefined) { if (v) tail.push(p.flag); continue; }
    const list = Array.isArray(v) ? v : [String(v)];
    if (p.option !== undefined) for (const x of list) tail.push(p.option, x);
    else if (p.position !== undefined) positional[p.position] = list;
    else if (p.env !== undefined) env[p.env] = list.join(',');
  }
  for (const k of Object.keys(values)) {
    if (!action.params.some((p) => p.name === k)) problems.push(`unknown param '${k}'`);
  }
  if (problems.length) throw new Error(problems.join('\n'));
  return { argv: [...argv, ...positional.flat().filter((x) => x !== undefined), ...tail], env };
}

function coerce(p, v, problems) {
  switch (p.type) {
    case 'bool':
      return v === true || v === 'true' || v === '1' || v === 'yes';
    case 'int':
    case 'number': {
      const n = Number(v);
      if (Number.isNaN(n) || (p.type === 'int' && !Number.isInteger(n))) { problems.push(`${p.name} must be ${p.type === 'int' ? 'an integer' : 'a number'}`); return undefined; }
      return n;
    }
    case 'enum':
      if (p.choices && !p.choices.map(String).includes(String(v))) { problems.push(`${p.name} must be one of ${p.choices.join(', ')}`); return undefined; }
      return v;
    case 'list':
      return Array.isArray(v) ? v : String(v).split(',').map((s) => s.trim()).filter(Boolean);
    default:
      return v;
  }
}

// Shell-free split that honours single and double quotes.
export function splitArgs(s) {
  const out = [];
  for (const m of s.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}
