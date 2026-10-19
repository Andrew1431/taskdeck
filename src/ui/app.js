// taskdeck web UI. No framework, no build: plain DOM, so `npx taskdeck ui` is all it takes.

window.addEventListener('unhandledrejection', (e) => console.error('taskdeck:', e.reason));

// ---------- token + api ----------
const hash = new URLSearchParams(location.hash.slice(1));
const hashToken = hash.get('t');
// A window the daemon opened for an agent's proposal lands on it.
const landing = { repo: hash.get('repo'), proposal: hash.get('proposal') };
if (hashToken) {
  sessionStorage.setItem('taskdeck-token', hashToken);
  history.replaceState(null, '', location.pathname);
}
const TOKEN = sessionStorage.getItem('taskdeck-token');
// `taskdeck ui` after a daemon restart may land on this tab with a new token in the hash.
window.addEventListener('hashchange', () => location.hash.includes('t=') && location.reload());

async function api(method, path, body) {
  const r = await fetch(path, {
    method,
    // x-taskdeck-client tells the daemon a UI is open, so it doesn't pop up another window.
    headers: { 'x-taskdeck-token': TOKEN ?? '', 'x-taskdeck-client': 'ui', 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
}

// ---------- tiny DOM helper ----------
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k in el && k !== 'list') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  return append(el, children);
}

// replaceChildren, but flattening arrays and skipping false/null like h() does.
function fill(el, ...children) {
  el.replaceChildren();
  return append(el, children);
}

function append(el, children) {
  for (const c of [children].flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
const $ = (id) => document.getElementById(id);

function ago(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(ts).toLocaleDateString();
}
const firstLine = (s) => (s ?? '').trim().split('\n')[0];
// YAML block scalars keep their hard wraps; join single newlines so text reflows.
const prose = (s) => (s ?? '').trim().replace(/([^\n])\n(?!\n)/g, '$1 ');

// ---------- state ----------
const state = {
  repos: [],
  repoId: localStorage.getItem('taskdeck-repo'),
  repo: null,
  proposals: [],
  runs: [],
  live: [], // running runs across every entry, for the rail
  selected: null, // { type: 'action'|'workflow'|'run', id, values?, proposalId? }
  doneSteps: {},
  health: {}, // group name → { up, detail }
};
if (landing.repo) state.repoId = landing.repo;

// ---------- boot ----------
if (!TOKEN) {
  fill($('repo'), h('div', { class: 'empty' }, h('h1', {}, 'Open taskdeck from the terminal'),
    h('p', {}, 'This page needs the key the daemon gives out. Run ', h('code', {}, 'npx taskdeck ui'), ' and it opens here signed in.')));
} else {
  loadRepos().then(async () => {
    restoreTabs();
    if (state.repoId) await selectRepo(state.repoId);
    const p = landing.proposal && state.proposals.find((x) => x.id === landing.proposal);
    if (p) review(p);
  });
  setInterval(refreshActivity, 3000);
  setInterval(watchDaemon, 5000);
  setInterval(refreshHealth, 5000);
}

// A newer client restarts the daemon on its new version; reload so this page runs the matching UI.
let daemonVersion;
async function watchDaemon() {
  const r = await api('GET', '/api/health').catch(() => ({ ok: false }));
  if (!r.ok) return;
  daemonVersion ??= r.data.version;
  if (r.data.version !== daemonVersion) location.reload();
}

$('add-repo').addEventListener('submit', async (e) => {
  e.preventDefault();
  const r = await api('POST', '/api/repos', { path: $('add-path').value.trim(), contract: $('add-contract').value.trim() || undefined });
  $('add-error').hidden = r.ok;
  if (!r.ok) return ($('add-error').textContent = r.data.error);
  $('add-path').value = $('add-contract').value = '';
  await loadRepos();
  selectRepo(r.data.id);
});

async function loadRepos() {
  const r = await api('GET', '/api/repos');
  if (!r.ok) return;
  state.repos = r.data;
  renderRail();
}

// Only unregisters it: the repo and its taskdeck.yaml stay where they are.
async function removeRepo(d) {
  if (!confirm(`Remove ${d.name} from taskdeck? Its files and taskdeck.yaml stay where they are.`)) return;
  let r = await api('DELETE', `/api/repos/${d.id}`, {});
  if (r.status === 409) {
    if (!confirm(`${r.data.running.length} run(s) in ${d.name} are still going. Stop them and remove it?`)) return;
    r = await api('DELETE', `/api/repos/${d.id}`, { force: true });
  }
  if (!r.ok) return alert(r.data.error);
  for (const t of repoTabs(d.id)) closeTab(t.run.id);
  state.repoId = state.repo = state.selected = null;
  localStorage.removeItem('taskdeck-repo');
  await loadRepos();
  if (state.repos[0]) return selectRepo(state.repos[0].id);
  fill($('repo'), h('div', { class: 'empty' }, h('h1', {}, 'No repo selected'), h('p', {}, 'Add a repo with a ', h('code', {}, 'taskdeck.yaml'), '.')));
  fill($('panel'));
}

async function selectRepo(id) {
  const r = await api('GET', `/api/repos/${id}`);
  if (!r.ok) {
    localStorage.removeItem('taskdeck-repo');
    return;
  }
  state.repoId = id;
  state.repo = r.data;
  state.health = {};
  refreshHealth();
  localStorage.setItem('taskdeck-repo', id);
  if (state.selected?.repoId !== id) state.selected = null;
  await refreshActivity(true);
  renderRail();
  renderRepo();
  renderPanel();
  showRepoTabs();
}

async function refreshActivity(force) {
  const [p, runs, live] = await Promise.all([api('GET', '/api/proposals'), state.repoId ? api('GET', `/api/runs?repo=${state.repoId}&limit=12`) : { ok: false }, api('GET', '/api/runs?live=1')]);
  const next = { proposals: p.ok ? p.data : [], runs: runs.ok ? runs.data : [], live: live.ok ? live.data : [] };
  const changed = JSON.stringify(next) !== JSON.stringify({ proposals: state.proposals, runs: state.runs, live: state.live });
  Object.assign(state, next);
  noticeNew(next);
  if (changed && !force) {
    renderRail();
    renderActivity();
  }
}

// What agents (or the CLI) did since the last poll: their runs open in the dock, and a new
// proposal opens for review unless you're in the middle of something else.
const known = { proposals: null, runs: new Set() };
function noticeNew({ proposals, live }) {
  const first = !known.proposals;
  const fresh = first ? [] : proposals.filter((p) => !known.proposals.has(p.id));
  const freshRuns = live.filter((r) => !known.runs.has(r.id) && r.by !== 'ui');
  known.proposals = new Set(proposals.map((p) => p.id));
  for (const r of live) known.runs.add(r.id);
  if (!first) {
    for (const r of freshRuns) api('GET', `/api/runs/${r.id}`).then((x) => x.ok && !dock.tabs.has(r.id) && openRun(x.data, { show: x.data.repoId === state.repoId }));
  }
  if (fresh.length) surface(fresh.at(-1));
}

async function surface(p) {
  const busy = !document.hidden && state.selected?.type === 'action' && !state.selected.proposalId;
  if (busy) return toast(p);
  if (p.repoId !== state.repoId) await selectRepo(p.repoId);
  review(p);
  window.focus();
}

const review = (p) => select({ type: 'action', id: p.actionId, values: p.values, proposalId: p.id, reason: p.reason });

function toast(p) {
  const repo = state.repos.find((r) => r.id === p.repoId)?.name;
  const el = h('div', { class: 'toast', role: 'status' },
    h('span', {}, h('strong', {}, 'Your agent suggested: '), p.title, repo && p.repoId !== state.repoId ? ` in ${repo}` : ''),
    h('button', { class: 'btn', onclick: async () => { el.remove(); if (p.repoId !== state.repoId) await selectRepo(p.repoId); review(p); } }, 'Review'),
    h('button', { class: 'link', onclick: () => el.remove() }, 'Later'));
  document.querySelector('.toast')?.remove();
  document.body.append(el);
  setTimeout(() => el.remove(), 20000);
}

// ---------- rail ----------
function renderRail() {
  const pendingBy = Map.groupBy(state.proposals, (p) => p.repoId);
  document.title = state.proposals.length ? `(${state.proposals.length}) taskdeck` : 'taskdeck';
  const liveBy = Map.groupBy(state.live, (x) => x.repoId);
  fill($('repos'), ...state.repos.map((r) => {
    const waiting = pendingBy.get(r.id)?.length;
    const running = liveBy.get(r.id) ?? [];
    return h('li', {}, h('button', { 'aria-current': r.id === state.repoId ? 'true' : 'false', onclick: () => selectRepo(r.id) },
      h('span', { class: 'name' }, r.name, running.length > 0 && h('span', { class: 'dot running', title: `Running: ${running.map((x) => x.title).join(', ')}` })),
      r.errors.length ? h('span', { class: 'count bad', title: r.errors.join('\n') }, '!')
        : waiting ? h('span', { class: 'tag run', title: `${waiting} waiting for you` }, waiting)
        : h('span', { class: 'count' }, r.actionCount)));
  }));
}

// ---------- repo ----------
async function refreshHealth() {
  const d = state.repo;
  if (!d || !Object.values(d.groups ?? {}).some((g) => g.health) || document.hidden) return;
  const r = await api('GET', `/api/repos/${d.id}/health`);
  if (!r.ok || state.repo !== d) return;
  state.health = r.data;
  for (const el of document.querySelectorAll('[data-health]')) paintHealth(el);
}

function paintHealth(el) {
  const s = state.health[el.dataset.health];
  el.className = `dot ${s ? (s.up ? 'up' : 'down') : ''}`;
  el.title = s ? `${s.up ? 'Up' : 'Down'}: ${s.detail}` : 'Checking…';
  return el;
}

function linkButtons(links) {
  return links.map((l) => h('a', { class: 'btn', href: l.url, target: '_blank', rel: 'noopener', title: l.description ?? l.url }, l.title, ' ↗'));
}

function renderRepo() {
  const d = state.repo;
  const groups = Map.groupBy(d.actions, (a) => a.group);
  // Groups with only links or a health check still get a section.
  for (const g of [...d.links.map((l) => l.group).filter(Boolean), ...Object.keys(d.groups)]) if (!groups.has(g)) groups.set(g, []);
  const linksBy = Map.groupBy(d.links, (l) => l.group ?? '');
  const gen = d.generatedBy;
  fill($('repo'), 
    h('header', { class: 'repo-head' },
      h('h1', {}, d.name),
      h('div', { class: 'path' }, d.path, h('button', { class: 'link remove-repo', onclick: () => removeRepo(d) }, 'Remove from taskdeck')),
      d.description && h('p', { class: 'desc' }, prose(d.description)),
      gen && h('div', { class: 'generated' }, 'Generated by ', h('strong', {}, gen.tool), '. Edits to this file are overwritten',
        gen.regenerate ? ['; change the source and run ', h('code', {}, gen.regenerate), '.'] : '.'),
      linksBy.has('') && h('div', { class: 'links' }, linkButtons(linksBy.get(''))),
      d.errors.length > 0 && h('div', { class: 'problems' }, h('strong', {}, 'The contract has problems'), h('ul', {}, d.errors.map((e) => h('li', {}, e))))),
    h('div', { id: 'activity' }),
    [...groups].map(([g, actions]) => h('section', { class: 'group' },
      h('h2', {},
        d.groups[g]?.health && paintHealth(h('span', { 'data-health': g })),
        h('span', {}, g),
        d.groups[g]?.description && h('span', { class: 'gdesc' }, firstLine(d.groups[g].description)),
        linksBy.has(g) && h('span', { class: 'links' }, linkButtons(linksBy.get(g)))),
      h('ul', { class: 'rows' }, actions.map((a) => h('li', { class: 'row', 'aria-current': isSel('action', a.id) ? 'true' : 'false' },
        h('button', { onclick: () => select({ type: 'action', id: a.id }) },
          h('span', { class: 'title' }, a.title),
          h('span', { class: 'sub' }, firstLine(a.description) || a.command),
          h('span', { class: 'tags' }, tags(a)))))))),
    Object.keys(d.workflows).length > 0 && h('section', { class: 'group' }, h('h2', {}, 'Workflows'),
      h('ul', { class: 'rows' }, Object.entries(d.workflows).map(([id, w]) => h('li', { class: 'row', 'aria-current': isSel('workflow', id) ? 'true' : 'false' },
        h('button', { onclick: () => select({ type: 'workflow', id }) },
          h('span', { class: 'title' }, w.title ?? id),
          h('span', { class: 'sub' }, w.description ?? `${w.steps.length} steps`)))))),
    Object.keys(d.configs).length > 0 && h('section', { class: 'group configs' }, h('h2', {}, 'Config files'),
      h('ul', { class: 'rows' }, Object.entries(d.configs).map(([id, c]) => h('li', { class: 'row' },
        h('div', {},
          h('span', { class: 'title' }, c.file),
          h('span', { class: 'tags' }, c.exists ? h('button', { class: 'btn', onclick: () => openFile(c.file) }, 'Open')
            : h('span', { class: 'tag high' }, c.example ? `missing; copy ${c.example}` : 'missing')),
          h('span', { class: 'sub' }, c.description ?? id)))))),
  );
  renderActivity();
}

function tags(a) {
  return [
    a.risk !== 'low' && h('span', { class: `tag ${a.risk}` }, `${a.risk} risk`),
    a.kind !== 'task' && h('span', { class: 'tag' }, a.kind),
    a.secrets.some((s) => !a.secretsSet[s]) && h('span', { class: 'tag medium', title: 'A required secret is not set in the daemon environment' }, 'secret missing'),
  ];
}

function renderActivity() {
  const host = $('activity');
  if (!host || !state.repo) return;
  const mine = state.proposals.filter((p) => p.repoId === state.repoId);
  fill(host, 
    mine.length > 0 && h('section', { class: 'section waiting' },
      h('h2', {}, mine.length === 1 ? 'Waiting for you' : `${mine.length} waiting for you`),
      mine.map((p) => h('div', { class: 'proposal' },
        h('div', {}, h('strong', {}, p.title), ' ', p.risk !== 'low' && h('span', { class: `tag ${p.risk}` }, `${p.risk} risk`)),
        h('div', { class: 'why' }, p.reason ?? 'Suggested by your agent', ' · ', ago(p.createdAt)),
        h('code', {}, p.command),
        h('div', { class: 'acts' },
          h('button', { class: 'btn', onclick: () => review(p) }, 'Review'),
          h('button', { class: 'link', onclick: async () => { await api('POST', `/api/proposals/${p.id}/dismiss`); refreshActivity(); } }, 'Dismiss'))))),
    state.runs.length > 0 && h('section', { class: 'group runs' }, h('h2', {}, 'Recent runs'),
      h('ul', { class: 'rows' }, state.runs.slice(0, 6).map((r) => h('li', { class: 'row', 'aria-current': isSel('run', r.id) ? 'true' : 'false' },
        h('button', { onclick: () => select({ type: 'run', id: r.id }) },
          h('span', { class: 'when' }, ago(r.startedAt)),
          h('span', { class: 'title' }, r.title, h('span', { class: 'sub' }, ` by ${r.by}`)),
          h('span', { class: 'tags' }, statusTag(r))))))),
  );
}

function statusTag(r) {
  const cls = { succeeded: 'ok', failed: 'fail', running: 'run' }[r.status] ?? '';
  const label = r.status === 'failed' && r.exitCode != null ? `failed (${r.exitCode})` : r.status;
  return h('span', { class: `tag ${cls}` }, label);
}

const isSel = (type, id) => state.selected?.type === type && state.selected?.id === id;

function select(sel) {
  state.selected = { ...sel, repoId: state.repoId };
  renderRepo();
  renderPanel();
  // Stacked layout (narrow window or right-hand dock): bring the details into view.
  if (getComputedStyle($('panel')).borderLeftWidth === '0px') $('panel').scrollIntoView({ behavior: 'smooth' });
}

// ---------- panel ----------
function renderPanel() {
  const sel = state.selected;
  if (!sel || !state.repo) return fill($('panel'), );
  if (sel.type === 'action') return renderAction(sel);
  if (sel.type === 'workflow') return renderWorkflow(sel.id);
  if (sel.type === 'run') return renderRun(sel.id);
}

function renderAction(sel) {
  const a = state.repo.actions.find((x) => x.id === sel.id);
  if (!a) return fill($('panel'), h('p', { class: 'error' }, `No action '${sel.id}' in this contract.`));
  const values = { ...(sel.values ?? {}) };
  const cmd = h('code', {}, a.command ?? '');
  const go = h('button', { class: 'go', onclick: () => fire() }, 'Run');
  const ext = h('button', { class: 'link', onclick: () => fire(true) }, 'Open in my terminal');
  const out = h('div');
  let armed = false;

  const preview = debounce(async () => {
    const r = await api('POST', `/api/repos/${state.repoId}/actions/${encodeURIComponent(a.id)}/preview`, { values: clean(values) });
    cmd.className = r.ok ? '' : 'invalid';
    cmd.textContent = r.ok ? r.data.command : r.data.error;
    go.disabled = !r.ok;
    disarm();
  }, 150);

  function disarm() {
    armed = false;
    go.classList.remove('armed');
    go.textContent = 'Run';
  }

  async function fire(terminal) {
    if (a.confirm && !armed) {
      armed = true;
      go.classList.add('armed');
      go.textContent = `Confirm ${a.risk}-risk run`;
      return;
    }
    go.disabled = true;
    const r = await api('POST', `/api/repos/${state.repoId}/actions/${encodeURIComponent(a.id)}/run`, { values: clean(values), confirmed: true, proposalId: sel.proposalId, terminal, ...guessSize() });
    go.disabled = false;
    disarm();
    if (!r.ok) return fill(out, h('p', { class: 'error' }, r.data.error));
    if (r.data.terminal) return fill(out, h('p', { class: 'note' }, 'Opened in a new terminal window.'));
    if (sel.proposalId) sel.proposalId = null;
    refreshActivity();
    fill(out);
    openRun(r.data, { focus: true });
  }

  fill($('panel'), 
    h('div', {},
      h('h2', {}, a.title),
      h('div', { class: 'meta' }, h('span', { class: 'tag mono' }, a.id), tags(a), a.agent !== 'run' && h('span', { class: 'tag' }, a.agent === 'never' ? 'humans only' : 'agents propose'))),
    sel.proposalId && h('div', { class: 'proposal-note' }, h('strong', {}, 'Your agent suggested this. '), sel.reason ?? ''),
    a.description && h('p', { class: 'desc' }, prose(a.description)),
    a.requires.length > 0 && h('div', {}, h('p', { class: 'note' }, 'Before you run it:'), h('ul', { class: 'plain' }, a.requires.map((x) => h('li', {}, x)))),
    a.secrets.map((s) => h('p', { class: `note ${a.secretsSet[s] ? '' : 'warn'}` }, h('code', {}, s), a.secretsSet[s] ? ' is set.' : ' is not set where the daemon runs. Set it, then restart the daemon.')),
    a.params.length > 0 && h('div', { class: 'fields' }, a.params.map((p) => field(a, p, values, preview))),
    h('div', {}, h('div', { class: 'console' }, h('div', { class: 'cmd' }, cmd, go)), h('div', { class: 'below' }, ext)),
    out,
  );
  preview();
}

function field(a, p, values, onChange) {
  const id = `f-${p.name}`;
  const label = h('label', { for: id }, p.name, p.required && h('span', { class: 'req', title: 'required' }, ' *'));
  const helpText = [p.description, p.default !== undefined && p.default !== null && `If omitted, the command uses ${p.default}`].filter(Boolean).join(' · ');
  const help = helpText && h('div', { class: 'help' }, helpText);
  const set = (v) => { values[p.name] = v; onChange(); };

  if (p.type === 'bool') {
    const input = h('input', { id, type: 'checkbox', checked: values[p.name] === true || values[p.name] === 'true', onchange: (e) => set(e.target.checked) });
    return h('div', { class: 'field check' }, input, label, help);
  }
  if (p.type === 'enum' && p.choices) {
    const sel = h('select', { id, onchange: (e) => set(e.target.value) },
      h('option', { value: '' }, p.required ? 'Choose…' : '(default)'),
      p.choices.map((c) => h('option', { value: c, selected: String(values[p.name] ?? '') === String(c) }, c)));
    return h('div', { class: 'field' }, label, sel, help);
  }
  const listId = `${id}-choices`;
  const value = Array.isArray(values[p.name]) ? values[p.name].join(', ') : values[p.name] ?? '';
  const input = h('input', {
    id, type: p.type === 'int' || p.type === 'number' ? 'number' : 'text', value,
    placeholder: p.type === 'list' ? 'comma, separated' : p.default != null ? String(p.default) : '',
    step: p.type === 'number' ? 'any' : undefined, list: p.choicesFrom ? listId : undefined,
    oninput: (e) => set(e.target.value),
  });
  if (!p.choicesFrom) return h('div', { class: 'field' }, label, input, help);
  const dl = h('datalist', { id: listId });
  const load = h('button', { class: 'btn', type: 'button', onclick: async () => {
    load.textContent = 'Loading…';
    const r = await api('GET', `/api/repos/${state.repoId}/actions/${encodeURIComponent(a.id)}/choices/${p.name}`);
    const found = r.ok ? r.data.choices : [];
    fill(dl, ...found.map((c) => h('option', { value: c })));
    load.textContent = found.length ? `${found.length} found` : 'None found';
    input.focus();
  } }, 'Load options');
  return h('div', { class: 'field' }, label, h('div', { class: 'inline' }, input, load), dl, help);
}

function clean(values) {
  return Object.fromEntries(Object.entries(values).filter(([, v]) => v !== '' && v !== undefined && v !== false));
}

// ---------- terminal dock ----------
// Terminals live in a dock below (or beside) the actions, one tab per run, so opening
// another action never takes away the output you were watching. Each rail entry has its
// own set of tabs; switching entries swaps them, and runs elsewhere keep going.
const MAX_TABS = 10;
const dock = { tabs: new Map(), active: null, activeBy: {}, prefs: { pos: 'bottom', height: 340, width: 620, collapsed: false, max: false } };
try {
  Object.assign(dock.prefs, JSON.parse(localStorage.getItem('taskdeck-dock') ?? '{}'));
} catch {}
const savePrefs = () => {
  try {
    localStorage.setItem('taskdeck-dock', JSON.stringify(dock.prefs));
  } catch {}
};
const saveTabs = () => sessionStorage.setItem('taskdeck-tabs', JSON.stringify({ ids: [...dock.tabs.keys()], activeBy: dock.activeBy }));
const repoTabs = (repoId = state.repoId) => [...dock.tabs.values()].filter((t) => t.run.repoId === repoId);

const ICONS = {
  bottom: '<rect x="3" y="4" width="14" height="12" rx="1.5"/><path d="M3 11h14"/>',
  right: '<rect x="3" y="4" width="14" height="12" rx="1.5"/><path d="M11.5 4v12"/>',
  max: '<path d="M4 8V4h4M16 12v4h-4M4 4l5 5M16 16l-5-5"/>',
  restore: '<path d="M9 4v5H4M11 16v-5h5M9 9 4 4M11 11l5 5"/>',
  down: '<path d="m5 8 5 5 5-5"/>',
  up: '<path d="m5 12 5-5 5 5"/>',
  close: '<path d="m6 6 8 8M14 6l-8 8"/>',
  gear: '<circle cx="10" cy="10" r="2.6"/><path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4"/>',
};
function icon(name) {
  const s = h('span', { class: 'icon', 'aria-hidden': 'true' });
  s.innerHTML = `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
  return s;
}

function applyDock() {
  const p = dock.prefs;
  const work = $('work');
  work.classList.toggle('has-dock', repoTabs().length > 0);
  work.classList.toggle('dock-right', p.pos === 'right');
  work.classList.toggle('dock-collapsed', p.collapsed);
  work.classList.toggle('dock-max', p.max);
  work.style.setProperty('--dock-h', `${p.height}px`);
  work.style.setProperty('--dock-w', `${p.width}px`);
  const tool = (id, name, label) => {
    const b = fill($(id), icon(name));
    b.title = label;
    b.setAttribute('aria-label', label);
  };
  tool('dock-pos', p.pos === 'right' ? 'bottom' : 'right', p.pos === 'right' ? 'Move the terminal to the bottom' : 'Move the terminal to the right');
  tool('dock-max', p.max ? 'restore' : 'max', p.max ? 'Restore the terminal size' : 'Maximize the terminal');
  tool('dock-collapse', p.collapsed ? 'up' : 'down', p.collapsed ? 'Show the terminal (Ctrl+`)' : 'Hide the terminal (Ctrl+`)');
  $('dock-max').hidden = p.collapsed;
}

function setCollapsed(collapsed) {
  dock.prefs.collapsed = collapsed;
  savePrefs();
  applyDock();
  if (!collapsed) dock.tabs.get(dock.active)?.focus();
}

$('dock-pos').addEventListener('click', () => {
  dock.prefs.pos = dock.prefs.pos === 'right' ? 'bottom' : 'right';
  dock.prefs.collapsed = false;
  savePrefs();
  applyDock();
});
$('dock-max').addEventListener('click', () => {
  dock.prefs.max = !dock.prefs.max;
  savePrefs();
  applyDock();
});
$('dock-collapse').addEventListener('click', () => setCollapsed(!dock.prefs.collapsed));
// Capture phase, so it works while xterm has focus too.
window.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key === '`' && repoTabs().length) {
    e.preventDefault();
    setCollapsed(!dock.prefs.collapsed);
  }
}, true);

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));
// `fromEdge`: pixels from the work area's bottom (or right) edge to the handle.
function sizeDock(fromEdge) {
  const r = $('work').getBoundingClientRect();
  if (dock.prefs.pos === 'right') dock.prefs.width = Math.round(clamp(fromEdge, 300, r.width - 360));
  else dock.prefs.height = Math.round(clamp(fromEdge, 120, r.height - 140));
  applyDock();
}
const handle = $('dock-handle');
handle.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  handle.setPointerCapture(e.pointerId);
  handle.classList.add('dragging');
  const r = $('work').getBoundingClientRect();
  const move = (ev) => sizeDock(dock.prefs.pos === 'right' ? r.right - ev.clientX : r.bottom - ev.clientY);
  handle.addEventListener('pointermove', move);
  handle.addEventListener('lostpointercapture', () => {
    handle.removeEventListener('pointermove', move);
    handle.classList.remove('dragging');
    savePrefs();
  }, { once: true });
});
handle.addEventListener('keydown', (e) => {
  const right = dock.prefs.pos === 'right';
  const delta = (right ? { ArrowLeft: 32, ArrowRight: -32 } : { ArrowUp: 32, ArrowDown: -32 })[e.key];
  if (!delta) return;
  e.preventDefault();
  sizeDock((right ? dock.prefs.width : dock.prefs.height) + delta);
  savePrefs();
});
applyDock();

// `show: false` adds the tab without switching to it (restoring other entries' tabs).
function openRun(run, { focus = false, show = true } = {}) {
  if (!dock.tabs.has(run.id)) {
    const t = createTab(run);
    dock.tabs.set(run.id, t);
    t.tab.hidden = t.pane.hidden = true;
    $('dock-tabs').append(t.tab);
    $('dock-panes').append(t.pane);
    const finished = repoTabs(run.repoId).filter((x) => x !== t && x.run.status !== 'running');
    while (repoTabs(run.repoId).length > MAX_TABS && finished.length) closeTab(finished.shift().run.id);
  }
  if (!show) return;
  dock.prefs.collapsed = false;
  activateTab(run.id, focus);
}

function activateTab(id, focus) {
  const repoId = dock.tabs.get(id)?.run.repoId;
  dock.active = id;
  if (repoId) dock.activeBy[repoId] = id;
  for (const [tid, t] of dock.tabs) {
    const on = tid === id;
    t.tab.hidden = t.run.repoId !== repoId;
    t.pane.hidden = !on;
    t.tab.classList.toggle('active', on);
    t.label.setAttribute('aria-selected', String(on));
  }
  applyDock();
  renderDockStatus();
  saveTabs();
  const t = dock.tabs.get(id);
  t?.tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  if (focus) t?.focus();
}

// Swap the dock to the selected entry's terminals.
function showRepoTabs() {
  const mine = repoTabs();
  const want = dock.activeBy[state.repoId];
  const id = mine.some((t) => t.run.id === want) ? want : mine.at(-1)?.run.id;
  if (id) return activateTab(id);
  dock.active = null;
  for (const t of dock.tabs.values()) t.tab.hidden = t.pane.hidden = true;
  applyDock();
  renderDockStatus();
}

function closeTab(id) {
  const t = dock.tabs.get(id);
  if (!t) return;
  t.dispose();
  t.tab.remove();
  t.pane.remove();
  dock.tabs.delete(id);
  if (dock.activeBy[t.run.repoId] === id) delete dock.activeBy[t.run.repoId];
  if (dock.active === id) {
    dock.active = null;
    if (t.run.repoId === state.repoId) return showRepoTabs();
  }
  applyDock();
  saveTabs();
}

function renderDockStatus() {
  fill($('dock-owner'), state.repo?.name ?? '');
  const r = dock.tabs.get(dock.active)?.run;
  if (!r) return fill($('dock-status'));
  const running = r.status === 'running';
  const secs = r.endedAt ? ` in ${((r.endedAt - r.startedAt) / 1000).toFixed(1)}s` : '';
  fill($('dock-status'),
    h('span', {}, running ? (r.pty ? 'Running. Click the terminal to type.' : 'Running')
      : `${r.status[0].toUpperCase()}${r.status.slice(1)}${r.exitCode != null ? ` (exit ${r.exitCode})` : ''}${secs}`),
    running && h('button', { class: 'stop', onclick: () => api('POST', `/api/runs/${r.id}/stop`) }, 'Stop'));
}

// Reopen this browser tab's terminals after a reload.
async function restoreTabs() {
  let saved;
  try {
    saved = JSON.parse(sessionStorage.getItem('taskdeck-tabs') ?? 'null');
  } catch {}
  if (!saved?.ids?.length) return;
  const runs = await Promise.all(saved.ids.map((id) => api('GET', `/api/runs/${id}`)));
  for (const r of runs) if (r.ok) openRun(r.data, { show: false });
  Object.assign(dock.activeBy, saved.activeBy);
  showRepoTabs();
}

function termTheme() {
  const css = getComputedStyle(document.documentElement);
  const v = (n) => css.getPropertyValue(n).trim();
  return { background: v('--term'), foreground: v('--term-ink'), cursor: v('--term-ink'), selectionBackground: v('--term-sel') };
}

// The size a new run should start at, so its first lines aren't wrapped for a narrower terminal.
function guessSize() {
  const panes = $('dock-panes');
  const width = panes.clientWidth || (dock.prefs.pos === 'right' ? dock.prefs.width : $('work').clientWidth);
  const height = panes.clientHeight || dock.prefs.height - 40;
  return { cols: Math.max(40, Math.floor((width - 24) / 7.8)), rows: Math.max(8, Math.floor((height - 12) / 17)) };
}

// One run's terminal: xterm.js fed by the daemon's SSE stream, keystrokes posted back
// (PTY runs only). Finished runs replay their saved output.
function createTab(run) {
  const t = { run };
  const dot = h('span', { class: 'dot' });
  const repo = state.repos.find((r) => r.id === run.repoId)?.name;
  t.label = h('button', { class: 'label', role: 'tab', title: [run.command, repo].filter(Boolean).join('\n'), onclick: () => activateTab(run.id, true) }, dot, run.title);
  t.tab = h('div', { class: 'dock-tab' }, t.label,
    h('button', { class: 'x', title: 'Close tab (a running command keeps going)', 'aria-label': `Close ${run.title}`, onclick: () => closeTab(run.id) }, icon('close')));
  const box = h('div', { class: 'term' });
  t.pane = h('div', { class: 'dock-pane', role: 'tabpanel' }, box);
  const isRunning = () => t.run.status === 'running';
  const setStatus = (r) => {
    t.run = r;
    dot.className = `dot ${r.status}`;
    if (dock.active === r.id) renderDockStatus();
  };
  setStatus(run);

  const term = new Terminal({
    convertEol: !run.pty, // piped output has bare \n
    fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--mono'),
    fontSize: 13,
    scrollback: 10000,
    cursorBlink: isRunning(),
    disableStdin: !run.pty,
    theme: termTheme(),
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);

  let pending = '';
  let flushT;
  term.onData((d) => {
    if (!isRunning() || !run.pty) return;
    pending += d;
    clearTimeout(flushT);
    flushT = setTimeout(() => {
      api('POST', `/api/runs/${run.id}/input`, { data: pending });
      pending = '';
    }, 8);
  });

  let opened = false;
  let wantFocus = false;
  const sync = () => {
    fit.fit();
    if (isRunning()) api('POST', `/api/runs/${run.id}/resize`, { cols: term.cols, rows: term.rows });
  };
  const resize = debounce(sync, 120);
  // xterm can only open into a visible box, so it waits for the first real size.
  const ro = new ResizeObserver(() => {
    if (!box.isConnected || box.clientWidth === 0) return;
    if (opened) return resize();
    term.open(box);
    opened = true;
    sync();
    if (wantFocus) term.focus();
  });
  ro.observe(box);
  t.focus = () => (opened ? term.focus() : (wantFocus = true));

  const es = new EventSource(`/api/runs/${run.id}/stream?t=${TOKEN}`);
  es.addEventListener('log', (e) => {
    const { text } = JSON.parse(e.data);
    if (text) term.write(text);
  });
  es.addEventListener('end', (e) => {
    setStatus(JSON.parse(e.data));
    es.close();
    term.options.cursorBlink = false;
    refreshActivity();
  });
  t.retheme = () => (term.options.theme = termTheme());
  t.dispose = () => {
    es.close();
    ro.disconnect();
    term.dispose();
  };
  return t;
}

async function renderRun(id) {
  const r = await api('GET', `/api/runs/${id}`);
  if (!r.ok) return fill($('panel'), h('p', { class: 'error' }, r.data.error));
  const run = r.data;
  const action = state.repo.actions.find((x) => x.id === run.actionId);
  openRun(run);
  fill($('panel'),
    h('div', {}, h('h2', {}, run.title), h('div', { class: 'meta' }, statusTag(run), h('span', { class: 'tag' }, `by ${run.by}`), h('span', { class: 'tag' }, new Date(run.startedAt).toLocaleString()))),
    h('div', { class: 'console' }, h('div', { class: 'cmd' }, h('code', {}, run.command))),
    action && h('button', { class: 'btn', onclick: () => select({ type: 'action', id: action.id }) }, 'Run it again'),
  );
}

// ---------- workflows ----------
function renderWorkflow(id) {
  const w = state.repo.workflows[id];
  const key = `${state.repoId}:${id}`;
  const done = (state.doneSteps[key] ??= new Set());
  const toggle = (i) => { done.has(i) ? done.delete(i) : done.add(i); renderWorkflow(id); };
  fill($('panel'), 
    h('div', {}, h('h2', {}, w.title ?? id), w.description && h('p', { class: 'desc' }, prose(w.description))),
    h('ol', { class: 'steps' }, w.steps.map((s, i) => {
      const a = s.action && state.repo.actions.find((x) => x.id === s.action);
      return h('li', { class: done.has(i) ? 'done' : '' },
        h('span', { class: 'what' }, a ? a.title : s.edit ? `Edit ${s.edit}` : s.manual),
        (s.description || (a && firstLine(a.description))) && h('span', { class: 'how' }, s.description ?? firstLine(a.description)),
        h('div', { class: 'do' },
          a && h('button', { class: 'btn', onclick: () => select({ type: 'action', id: a.id, values: s.with }) }, 'Open action'),
          s.edit && h('button', { class: 'btn', onclick: () => openFile(s.edit) }, 'Open file'),
          h('button', { class: 'link', onclick: () => toggle(i) }, done.has(i) ? 'Mark not done' : 'Mark done')));
    })),
  );
}

async function openFile(file) {
  const r = await api('POST', `/api/repos/${state.repoId}/open`, { file });
  if (!r.ok) alert(r.data.error);
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// ---------- settings: themes ----------
// Each theme is a [data-theme] block in style.css; "system" follows the OS light/dark setting.
const THEMES = [
  ['system', 'System'], ['light', 'Light'], ['dark', 'Dark'],
  ['solarized-light', 'Solarized Light'], ['solarized-dark', 'Solarized Dark'],
  ['gruvbox-light', 'Gruvbox Light'], ['gruvbox-dark', 'Gruvbox Dark'],
  ['catppuccin-latte', 'Catppuccin Latte'], ['catppuccin-mocha', 'Catppuccin Mocha'],
  ['nord', 'Nord'], ['dracula', 'Dracula'], ['tokyo-night', 'Tokyo Night'],
  ['one-dark', 'One Dark'], ['rose-pine', 'Rosé Pine'], ['monokai', 'Monokai'],
];
const currentTheme = () => document.documentElement.dataset.theme ?? 'system';

function setTheme(id) {
  if (id === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = id;
  try {
    id === 'system' ? localStorage.removeItem('taskdeck-theme') : localStorage.setItem('taskdeck-theme', id);
  } catch {}
  for (const t of dock.tabs.values()) t.retheme();
  renderThemes();
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => currentTheme() === 'system' && setTheme('system'));

function renderThemes() {
  const now = currentTheme();
  fill($('themes'), THEMES.map(([id, name]) => {
    // A swatch is a miniature of the app in that theme: rail, panel, accent, terminal.
    const mini = (theme) => h('span', { class: 'mini', 'data-theme': theme },
      h('span', { class: 'mini-rail' }), h('span', { class: 'mini-main' }, h('span', { class: 'mini-accent' }), h('span', { class: 'mini-line' })), h('span', { class: 'mini-term' }));
    return h('button', { type: 'button', role: 'radio', class: 'theme', 'aria-checked': String(id === now), onclick: () => setTheme(id) },
      id === 'system' ? h('span', { class: 'mini-split' }, mini('light'), mini('dark')) : mini(id),
      h('span', { class: 'theme-name' }, name));
  }));
}

$('open-settings').append(icon('gear'));
$('open-settings').addEventListener('click', () => {
  renderThemes();
  $('settings').showModal();
});

// ---------- folder picker ----------
// Browsers can't give a page a real folder path, so the daemon lists folders for us.
const picker = { mode: 'folder', path: null, onPick: null };

function openPicker(mode, start, onPick) {
  Object.assign(picker, { mode, onPick });
  $('picker-title').textContent = mode === 'folder' ? 'Choose a folder' : 'Choose a contract file';
  $('picker-use').hidden = mode !== 'folder';
  browse(start);
  $('picker').showModal();
}

async function browse(path) {
  const r = await api('GET', `/api/fs?${new URLSearchParams({ ...(path ? { path } : {}), ...(picker.mode === 'file' ? { files: '1' } : {}) })}`);
  if (!r.ok) return;
  const d = r.data;
  picker.path = d.path;
  $('picker-path').value = d.path;
  fill($('picker-roots'),
    h('button', { type: 'button', onclick: () => browse(d.home) }, 'Home'),
    d.roots.length > 1 && d.roots.map((x) => h('button', { type: 'button', onclick: () => browse(x) }, x.replace(/\\$/, ''))));
  const sep = d.path.includes('\\') ? '\\' : '/';
  const join = (name) => `${d.path.replace(/[\\/]$/, '')}${sep}${name}`;
  fill($('picker-list'),
    d.parent && h('li', {}, h('button', { type: 'button', onclick: () => browse(d.parent) }, h('span', { class: 'fname' }, '..'), h('span', { class: 'fmeta' }, 'Up one folder'))),
    d.error && h('li', { class: 'error' }, d.error),
    d.dirs.map((x) => h('li', {}, h('button', { type: 'button', class: x.name.startsWith('.') ? 'dim' : '', onclick: () => browse(join(x.name)), ondblclick: () => picker.mode === 'folder' && use(join(x.name)) },
      h('span', { class: 'fname' }, x.name),
      h('span', { class: 'fmeta' }, x.contract && h('span', { class: 'tag ok' }, 'taskdeck.yaml'), x.git && h('span', { class: 'tag' }, 'git'))))),
    d.files.map((f) => h('li', {}, h('button', { type: 'button', class: 'file', onclick: () => use(join(f)) }, h('span', { class: 'fname' }, f), h('span', { class: 'fmeta' }, 'Choose')))),
    !d.error && !d.dirs.length && !d.files.length && h('li', { class: 'none' }, picker.mode === 'file' ? 'No folders or YAML files here.' : 'No folders here.'));
  $('picker-hint').textContent = picker.mode === 'folder' ? (d.contract ? 'Has a taskdeck.yaml.' : 'No taskdeck.yaml here; add one with --contract or ask your agent to write it.') : '';
  $('picker-list').scrollTop = 0;
}

function use(path) {
  $('picker').close();
  picker.onPick(path);
}

$('picker-use').addEventListener('click', () => use(picker.path));
$('picker-go').addEventListener('submit', (e) => {
  e.preventDefault();
  browse($('picker-path').value.trim());
});
// Start next to the entry you're looking at: worktrees usually sit beside each other.
const pickerStart = (input) => input.value.trim() || (state.repo ? state.repo.path.replace(/[\\/][^\\/]+[\\/]?$/, '') : '');
$('browse-path').addEventListener('click', () => openPicker('folder', pickerStart($('add-path')), (p) => {
  $('add-path').value = p;
  $('add-repo').querySelector('[type=submit]').focus();
}));
$('browse-contract').addEventListener('click', () => openPicker('file', $('add-contract').value.trim().replace(/[\\/][^\\/]+\.ya?ml$/i, '') || pickerStart($('add-path')), (p) => {
  $('add-contract').value = p;
}));
