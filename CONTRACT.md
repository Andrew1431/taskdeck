# taskdeck.yaml

One file at the repo root. It doesn't care what runs your commands: an action is an argv,
and params say how values reach that argv. npm scripts, PowerShell, make, cargo, a custom
CLI, terraform: anything you'd type in a terminal.

```yaml
version: 1
name: My Project
description: One paragraph a newcomer reads first.

configs:            # files people edit by hand
  <id>:
    file: infra/terraform.tfvars        # %VAR%, $VAR and ~ are expanded
    example: infra/terraform.tfvars.example
    format: hcl | dotenv | json | yaml | ini | lines | other
    description: What it controls and when to change it.
    secrets: [key_name]                 # never shown to an agent
    local: true                         # machine-specific / gitignored

actions:
  <id>:
    title: Start a server               # what the button says
    description: Why/when, what it changes, what to run first.
    group: Servers                      # UI section
    run: pnpm run cli start             # string (quotes respected) or argv list
    # run: { windows: ..., macos: ..., linux: ..., default: ... }
    cwd: .                              # relative to repo root
    kind: task | service | detached | interactive
    risk: low | medium | high
    agent: run | propose | never        # default: run, or propose when risk is high
    confirm: true                       # default: true when risk is high
    secrets: [TCLI_AUTH_TOKEN]          # env vars that must be set; values never stored
    requires: [Asset bundle built in Unity]
    params:
      <name>:
        type: string | int | number | bool | enum | path | list
        description: ...
        required: true
        default: 2                      # what happens when omitted; documentation, not passed
        choices: [worker, interactions] # enum
        choicesFrom: { run: pnpm run cli list, pattern: '^(\S+)' }   # dynamic choices
        # exactly one of:
        flag: --skip-build              # bool; emitted when true
        option: --port                  # emits `--port value` (repeated for list)
        position: 0                     # positional, after the base argv
        env: TARGET                     # set as an environment variable

  up-{service}:                         # `each` repeats an action once per value
    title: Start {service}
    group: "{service}"
    run: mycli up {service}
    each: { service: [web, api, worker] }   # several keys: one copy per combination

links:              # open-in-browser buttons
  <id>:
    title: Open web
    url: http://localhost:3000/
    group: web                          # shown in that group's header; omit for the top of the page
    description: ...

groups:             # optional, keyed by the `group` name actions use
  web:
    description: The Next.js app.
    health: http://localhost:3000/      # up when it answers with a status below 500
    # health: { run: mycli status web, cwd: . }   # up when it exits 0
  "{service}":                          # `each` works here and on links too
    health: { run: "mycli status {service}" }
    each: { service: [api, worker] }

generatedBy:        # the contract is written by a tool; hand edits get overwritten
  tool: mycli
  regenerate: mycli render

workflows:
  <id>:
    title: Release a version
    steps:
      - edit: thunderstore/manifest.json
        description: Bump version_number.
      - manual: Load-test in the Dev profile.
      - action: publish
        with: { team: Andrew1431 }
```

Argv is built as: `run` + positional params in order + flags/options in declaration order.
Params you don't set are omitted, so the command's own defaults stay the source of truth.

`each` replaces `{name}` in the id and in every string inside the entry. The id must use
every key, so each copy gets its own id. In YAML, quote strings that start with `{` or contain
`{name}` inside a `{ flow: map }`, e.g. `title: "Open {service}"`.

Health checks run when the UI or an agent asks (the UI asks every 5 seconds), with a 3s
timeout for URLs and 10s for commands. They show as a dot by the group's name, and in the
MCP `taskdeck_list` output.
