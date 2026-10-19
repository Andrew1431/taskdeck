# Changelog

## Unreleased

### MCP
- `taskdeck_run_status` takes `wait_seconds` and waits for a running run to finish, the same
  way `taskdeck_run` does, so agents don't need sleep loops. The default (0) returns right away,
  as before. To wait on several runs, call it for each run in parallel.
- `taskdeck_run_status` and `taskdeck_recent_runs` show elapsed time for running entries
  ("running for 18s").
- `taskdeck_add` says "Already added: …" when the folder is already registered.

### CLI
- `taskdeck --version` (or `taskdeck version`) prints the version and exits.
- `taskdeck add` on a folder that's already registered prints "Already added: <name> (id …)"
  and still exits 0. `--json` prints the repo summary with `added: true|false`.
- `taskdeck show` describes a param's `default` as "if omitted, the command uses 80". The
  `default` is documentation; taskdeck never passes it.
- On startup time: taskdeck starts in about 0.1–0.3s. Most of the time `npx taskdeck` takes is
  npx's own overhead. Tools that call taskdeck often should install it globally
  (`npm i -g taskdeck`) and call `taskdeck` directly.

### UI
- A param's `default` shows as "If omitted, the command uses …", matching `show`.
