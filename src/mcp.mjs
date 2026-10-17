// MCP server over stdio (newline-delimited JSON-RPC). Thin: every tool is a daemon API call,
// so the agent and the UI see the same runs and proposals.
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { api } from './client.mjs';
import { FILE } from './contract.mjs';

const INSTRUCTIONS = `taskdeck holds this repo's commands (taskdeck.yaml): documented, typed, with risk levels.
- Before telling the user to run a command, check taskdeck_list. If the command is there, don't print it for them to copy:
  run it with taskdeck_run when its policy allows, otherwise queue it with taskdeck_propose and a one-line reason.
  Proposals wait in the user's taskdeck UI with a Run button, so they survive after this chat.
- If a command the user needs isn't in the contract, say so and suggest adding it to taskdeck.yaml.
- Never put secret values in params; secrets come from the user's environment.`;

const TOOLS = [
  {
    name: 'taskdeck_list',
    description: "List the repo's actions, workflows and config files from taskdeck.yaml, with each action's risk and whether an agent may run it.",
    inputSchema: { type: 'object', properties: { repo: { type: 'string', description: 'Repo path or taskdeck repo id. Default: the current project.' } } },
  },
  {
    name: 'taskdeck_describe',
    description: "One action's docs, params (type, how they map to the command), requirements and secrets.",
    inputSchema: { type: 'object', required: ['action'], properties: { action: { type: 'string' }, repo: { type: 'string' } } },
  },
  {
    name: 'taskdeck_run',
    description: 'Run an action the contract lets agents run. Waits up to wait_seconds, then returns status and the output tail (or a run_id to check later).',
    inputSchema: {
      type: 'object', required: ['action'],
      properties: {
        action: { type: 'string' },
        values: { type: 'object', description: 'Param values by param name, e.g. {"id": "mc", "ports": "tcp:25565"}', additionalProperties: true },
        repo: { type: 'string' },
        wait_seconds: { type: 'number', default: 60 },
      },
    },
  },
  {
    name: 'taskdeck_propose',
    description: "Queue an action for the user to run from the taskdeck UI. Use for high-risk or human-only actions, or whenever you'd otherwise tell the user to run something later.",
    inputSchema: {
      type: 'object', required: ['action', 'reason'],
      properties: {
        action: { type: 'string' },
        values: { type: 'object', additionalProperties: true },
        reason: { type: 'string', description: 'One line: why, and what to check first.' },
        repo: { type: 'string' },
      },
    },
  },
  {
    name: 'taskdeck_run_status',
    description: 'Status and output tail of a run.',
    inputSchema: { type: 'object', required: ['run_id'], properties: { run_id: { type: 'string' }, tail_chars: { type: 'number', default: 4000 } } },
  },
  {
    name: 'taskdeck_recent_runs',
    description: "Recent runs in this repo (from the UI, agents or CLI): what ran, when, and whether it worked.",
    inputSchema: { type: 'object', properties: { repo: { type: 'string' }, limit: { type: 'number', default: 15 } } },
  },
  {
    name: 'taskdeck_add',
    description: "Add a repo to the user's taskdeck UI. Pass contract when its taskdeck.yaml lives somewhere other than the repo root (e.g. a generated contract spanning several worktrees).",
    inputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string', description: 'Repo root (action cwd paths resolve from here).' }, contract: { type: 'string' } } },
  },
  {
    name: 'taskdeck_remove',
    description: "Take a repo out of the user's taskdeck UI, e.g. when tearing down a worktree. Its files and taskdeck.yaml are untouched; pending proposals for it are dismissed. Refuses while its runs are going unless force is true.",
    inputSchema: { type: 'object', required: ['repo'], properties: { repo: { type: 'string', description: 'Repo path or taskdeck repo id.' }, force: { type: 'boolean', default: false } } },
  },
];

export function startMcp() {
  const rl = createInterface({ input: process.stdin });
  const write = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
    }
    if (msg.id === undefined) return; // notifications
    try {
      write({ jsonrpc: '2.0', id: msg.id, result: await dispatch(msg.method, msg.params ?? {}) });
    } catch (e) {
      write({ jsonrpc: '2.0', id: msg.id, error: { code: e.code ?? -32603, message: e.message } });
    }
  });
}

async function dispatch(method, params) {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: params.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'taskdeck', version: '0.0.1' },
        instructions: INSTRUCTIONS,
      };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: TOOLS };
    case 'tools/call':
      try {
        return { content: [{ type: 'text', text: await callTool(params.name, params.arguments ?? {}) }] };
      } catch (e) {
        return { content: [{ type: 'text', text: e.message }], isError: true };
      }
    default:
      throw Object.assign(new Error(`method not found: ${method}`), { code: -32601 });
  }
}

async function callTool(name, args) {
  switch (name) {
    case 'taskdeck_list': {
      const repo = await resolveRepo(args.repo);
      const d = must(await api('GET', `/api/repos/${repo.id}`));
      const lines = [`${d.name} (repo id: ${d.id})`, d.description ?? '', ''];
      if (d.errors.length) lines.push(`Contract problems: ${d.errors.join('; ')}`, '');
      for (const a of d.actions) {
        const params = a.params.map((p) => `${p.name}${p.required ? '*' : ''}:${p.type}`).join(', ');
        lines.push(`- ${a.id}: ${a.title} [risk ${a.risk}, agent ${a.confirm && a.agent === 'run' ? 'propose' : a.agent}${a.kind !== 'task' ? `, ${a.kind}` : ''}]${params ? ` (${params})` : ''}`);
      }
      const wf = Object.entries(d.workflows);
      if (wf.length) {
        lines.push('', 'Workflows:');
        for (const [id, w] of wf) lines.push(`- ${id}: ${w.title ?? id}: ${w.steps.map((s) => s.action ?? (s.edit ? `edit ${s.edit}` : 'manual step')).join(' → ')}`);
      }
      const cfg = Object.entries(d.configs);
      if (cfg.length) {
        lines.push('', 'Config files:');
        for (const [id, f] of cfg) lines.push(`- ${id}: ${f.file}${f.exists ? '' : ' (missing)'}: ${f.description ?? ''}`);
      }
      return lines.join('\n');
    }
    case 'taskdeck_describe': {
      const repo = await resolveRepo(args.repo);
      const d = must(await api('GET', `/api/repos/${repo.id}`));
      const a = d.actions.find((x) => x.id === args.action);
      if (!a) throw new Error(`No action '${args.action}'. Available: ${d.actions.map((x) => x.id).join(', ')}`);
      const { secretsSet, ...rest } = a;
      return JSON.stringify({ ...rest, secrets: a.secrets.map((s) => `${s} (${secretsSet[s] ? 'set' : 'not set'} in daemon env)`) }, null, 2);
    }
    case 'taskdeck_run': {
      const repo = await resolveRepo(args.repo);
      const r = await api('POST', `/api/repos/${repo.id}/actions/${encodeURIComponent(args.action)}/run`, { values: args.values ?? {}, by: 'agent' });
      if (r.status === 403) return `${r.data.error} Use taskdeck_propose instead.\nCommand: ${r.data.command}`;
      const run = must(r);
      if (run.terminal) return `Opened in a terminal window for the user (interactive): ${run.command}`;
      const deadline = Date.now() + (args.wait_seconds ?? 60) * 1000;
      let cur = run;
      while (cur.status === 'running' && Date.now() < deadline) {
        await new Promise((res) => setTimeout(res, 500));
        cur = must(await api('GET', `/api/runs/${run.id}?tail=4000&plain`));
      }
      if (cur.status === 'running') return `Still running after ${args.wait_seconds ?? 60}s. run_id: ${run.id} (check with taskdeck_run_status). The user can watch it in the taskdeck UI.`;
      return formatRun(must(await api('GET', `/api/runs/${run.id}?tail=4000&plain`)));
    }
    case 'taskdeck_propose': {
      const repo = await resolveRepo(args.repo);
      const p = must(await api('POST', '/api/proposals', { repoId: repo.id, actionId: args.action, values: args.values ?? {}, reason: args.reason, by: 'agent' }));
      return `Queued for the user in the taskdeck UI (proposal ${p.id}): ${p.title}\nCommand: ${p.command}\nTell the user it's waiting there; don't ask them to copy the command.`;
    }
    case 'taskdeck_run_status':
      return formatRun(must(await api('GET', `/api/runs/${encodeURIComponent(args.run_id)}?tail=${args.tail_chars ?? 4000}&plain`)));
    case 'taskdeck_recent_runs': {
      const repo = await resolveRepo(args.repo);
      const runs = must(await api('GET', `/api/runs?repo=${repo.id}&limit=${args.limit ?? 15}`));
      if (!runs.length) return 'No runs yet.';
      return runs.map((r) => `${new Date(r.startedAt).toISOString()}  ${r.actionId.padEnd(16)} ${r.status}${r.exitCode != null ? ` (exit ${r.exitCode})` : ''} by ${r.by}  run_id ${r.id}`).join('\n');
    }
    case 'taskdeck_add': {
      const r = must(await api('POST', '/api/repos', { path: resolve(args.path), contract: args.contract ? resolve(args.contract) : undefined }));
      return `Added ${r.name} (repo id ${r.id}, ${r.actionCount} actions)${r.errors.length ? `. Contract problems: ${r.errors.join('; ')}` : ''}`;
    }
    case 'taskdeck_remove': {
      const repos = must(await api('GET', '/api/repos'));
      const repo = repos.find((r) => r.id === args.repo) ?? repos.find((r) => r.path.toLowerCase() === resolve(args.repo).toLowerCase());
      if (!repo) throw new Error(`'${args.repo}' isn't in taskdeck. Registered: ${repos.map((r) => r.id).join(', ') || '(none)'}`);
      const r = await api('DELETE', `/api/repos/${repo.id}`, { force: !!args.force });
      if (r.status === 409) return `Not removed: ${r.data.running.length} run(s) still going (${r.data.running.map((x) => x.title).join(', ')}). Pass force: true to stop them, after checking with the user.`;
      must(r);
      return `Removed ${repo.name} from taskdeck${r.data.stopped ? ` and stopped ${r.data.stopped} run(s)` : ''}. Its files are untouched.`;
    }
    default:
      throw new Error(`unknown tool ${name}`);
  }
}

function formatRun(r) {
  const secs = r.endedAt ? ((r.endedAt - r.startedAt) / 1000).toFixed(1) : null;
  return `${r.title}: ${r.status}${r.exitCode != null ? ` (exit ${r.exitCode})` : ''}${secs ? ` after ${secs}s` : ''}\n$ ${r.command}\n\n${r.log || '(no output)'}`;
}

function must(r) {
  if (!r.ok) throw new Error(r.data?.error ?? `daemon error ${r.status}`);
  return r.data;
}

// A repo id, or a path anywhere inside a repo; unregistered repos with a taskdeck.yaml are added.
async function resolveRepo(arg) {
  const repos = must(await api('GET', '/api/repos'));
  if (arg && repos.some((r) => r.id === arg)) return repos.find((r) => r.id === arg);
  let dir = resolve(arg ?? process.env.TASKDECK_REPO ?? process.cwd());
  for (;;) {
    const hit = repos.find((r) => r.path.toLowerCase() === dir.toLowerCase());
    if (hit) return hit;
    if (existsSync(resolve(dir, FILE))) return must(await api('POST', '/api/repos', { path: dir }));
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error(`No taskdeck.yaml found for ${arg ?? process.cwd()}. Set one up by following AGENT_SETUP.md in the taskdeck package, or pass a repo id from: ${repos.map((r) => r.id).join(', ') || '(none registered)'}`);
}
