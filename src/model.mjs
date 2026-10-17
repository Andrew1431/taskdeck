// The normalized shape every adapter emits. Runners differ; the UI, the MCP server and
// the docs only ever see this.
//
// Action {
//   id          stable key, "<adapter>:<relative path or package>:<name>"
//   adapter     'npm' | 'ps1' | ...
//   name        what a human would call it ("deploy", "launch-two")
//   group       where it sits in the UI (package name, folder)
//   description best-effort prose pulled from the source; null when there is none
//   source      { file, line } so docs can link back and staleness can be detected
//   run         { cwd, command, args[] } — argv, never a shell string, so quoting is ours
//   params      Param[]
//   env         env vars the action reads (secrets get masked, never sent to the AI)
//   risk        'low' | 'high' (heuristic until a contract overrides it)
//   kind        'task' (runs and exits) | 'detached' (starts things that outlive it)
//   notes       adapter warnings worth showing ("`pnpm deploy` is a pnpm builtin")
// }
//
// Param { name, type: 'string'|'int'|'number'|'bool'|'enum'|'path', default, required,
//         choices?, description, position? (positional arg index) }

const HIGH_RISK = /\b(deploy|publish|upload|release|destroy|delete|prune|drop|reset|wipe)\b/i;

export function riskFor(...texts) {
  return texts.some((t) => t && HIGH_RISK.test(t.replace(/[-_:]/g, ' '))) ? 'high' : 'low';
}

export function action(fields) {
  return {
    description: null,
    params: [],
    env: [],
    kind: 'task',
    notes: [],
    ...fields,
    risk: fields.risk ?? riskFor(fields.name, fields.run?.args?.join(' ')),
  };
}
