# Taskdeck setup — instructions for an AI agent

You were pointed here to give a repository a `taskdeck.yaml`: one file that lists every
command a human runs in this repo, documented and typed, so they can run it later from the
taskdeck CLI/UI (or ask an agent to) without re-deriving how it works.

Work in the repository the user named (default: the current directory). Do the steps in order.

## 1. Gather facts

- Run `npx taskdeck discover` in the repo (or `node <taskdeck>/src/cli.mjs discover --repo <repo>`).
  It parses npm/pnpm/yarn scripts and PowerShell `param()` blocks into a draft: names,
  typed params, defaults, header comments, env vars. Treat it as facts, not as the answer.
- Then read what the helpers can't see:
  - README, CONTRIBUTING, CLAUDE.md, AGENTS.md, docs/: the commands they tell people to run.
  - Any CLI the repo ships (a `bin`, a `cmd/`, a `__main__`): its subcommands and flags.
  - Makefile, justfile, Taskfile.yml, mise.toml, Cargo/pyproject scripts, `scripts/`, `*.sh`,
    `*.ps1`, `*.bat`: anything a person invokes.
  - Config files people edit by hand (`.env`, `*.tfvars`, `*.ini`, `*.cfg`, manifests) and
    their `.example` siblings.
  - Multi-step chores described in prose ("bump the version in X and Y, then run Z").

## 2. Write `taskdeck.yaml` at the repo root

Follow [CONTRACT.md](CONTRACT.md). The rules that matter most:

- **One action per thing a human would click**, not per script. A CLI with subcommands
  becomes several actions (`start`, `stop`, `create`...). A script with a dangerous switch
  (`package.ps1 -Upload`) can become two actions (`package`, `publish`).
- **`run` is the exact argv**, as the user would type it from `cwd`. Prefer the repo's own
  wrapper (`pnpm run deploy`, not the script it calls). Always `npm run x`/`pnpm run x`, never
  bare `pnpm x` (many names collide with package-manager builtins).
- **Every param says how it reaches the command**: `flag` (bool switch), `option` (flag +
  value), `position` (positional arg), or `env` (environment variable). Add `type`,
  `description`, `choices` when there's a closed set, and `default` for what happens when
  it's omitted (documentation only; it is not passed).
- **Descriptions explain why and when**, in a sentence or two: what it changes, what to run
  before it, what can go wrong. Pull the facts from the code and docs; don't invent.
- **Risk**: `high` for anything that publishes, deploys, deletes, spends money or can't be
  undone; `medium` for things that change shared state but recover. High-risk defaults to
  `agent: propose` (an agent may queue it, a human runs it). Use `agent: never` for
  destructive actions.
- **Secrets** go in `secrets: [ENV_NAME]` by name only. Never write a secret value anywhere.
- **kind**: `service` for dev servers/watchers, `detached` for things that launch apps and
  return, `interactive` for anything that needs a TTY (ssh, prompts).
- **Config files** the user edits go under `configs:` with their example file and which
  keys are secret. Machine-specific ones get `local: true`.
- **Workflows** capture the chores: ordered `edit:`, `manual:` and `action:` steps.
- Quote YAML strings that contain `, : # { }` inside `{ flow: maps }`.

## 3. Check it

Run `taskdeck check`. Fix every ✗. Each `· not in contract:` line is something discovery
found that the contract doesn't mention: add it, or leave it out on purpose (e.g. a
package's internal `start` that the root `dev` already wraps) and say so to the user.

Dry-run two or three actions with params: `taskdeck run <id> key=value --dry-run`, and
confirm the printed command is what a human would type.

## 4. Report

Tell the user, briefly: how many actions, the workflows you captured, anything you
couldn't determine (ask them), and that `taskdeck list` shows it all. Don't run any
`risk: high` action.
