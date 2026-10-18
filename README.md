# taskdeck

A task runner built for working with coding agents. Like a Makefile or justfile, each repo
gets one file, `taskdeck.yaml`, listing the commands people run in it. You run them from
the CLI or a local UI, and your agent runs them over MCP.

Every repo grows commands you forget: `pnpm run deploy worker --skip-build`,
`.\launch-two.ps1 -Count 3 -Manual`, "edit tfvars, then apply, then deploy". make and just
gave those commands a name. taskdeck also tells you, and your agent, how to run each one
and how risky it is:

- **Typed params.** Every action is a form in the UI and a schema for agents, so nobody
  guesses flags.
- **Risk levels.** Your agent runs the safe actions itself. A deploy or a delete becomes a
  proposal with a Run button for you, not a command in chat that you forget by tomorrow.
- **Nothing to rewrite.** Actions call what you already have: npm scripts, PowerShell, make,
  or your own CLI.
- **Somewhere to watch them.** Each repo gets real terminals, run history and multi-step
  workflows shown as checklists, all kept by one small local daemon.

## Get started

Add taskdeck to your agent once:

```bash
npx taskdeck init --claude
```

`init` adds taskdeck's MCP server to the client you name, using the right command for your
OS:

- `--claude` for Claude Code
- `--copilot` (or `--vscode`) for GitHub Copilot in VS Code
- `--cursor` for Cursor
- `--windsurf` for Windsurf

Name several clients, or pass `--all` for every one installed. With no flags, `init` asks
about each client it finds. `--dry-run` shows what it would change. For any other MCP client, add the
server yourself: `"command": "npx", "args": ["-y", "taskdeck@latest", "mcp"]` (on Windows,
`"command": "cmd", "args": ["/c", "npx", "-y", "taskdeck@latest", "mcp"]`).

Then open a new chat in any repo (chats that are already open don't load new MCP servers)
and say:

> set up taskdeck

In Claude Code, `/mcp__taskdeck__setup` does the same. The agent finds the repo's commands,
reads its docs, writes `taskdeck.yaml` and checks it. If your agent has no MCP, ask it to
read [AGENT_SETUP.md](AGENT_SETUP.md) and do what it says.

After that, the agent checks taskdeck before it tells you to run anything. It runs what the
contract allows (`agent: run`) and proposes the rest. If no taskdeck window is open, one
opens on the proposal (set `TASKDECK_POPUP=0` in the daemon's environment to turn that off).
An open window brings the proposal up for review, and runs the agent starts show up in its
terminal dock.

## The UI

```bash
npx taskdeck ui
```

This command starts the daemon if it isn't running and adds the current repo. It opens in
its own window (Chrome, Edge or Brave app mode); `--browser` opens a normal tab instead.

- **Run actions.** Fill in the form and the exact command updates as you type. Press Run to
  watch it in a real terminal, with colors, progress bars and prompts you can type into.
  "Open in my terminal" sends it to your own terminal instead.
- **Keep going after you close the tab.** Runs carry on in the daemon. High-risk actions ask
  you to confirm first.
- **Review proposals.** Proposals from your agent wait under "Waiting for you" until you run
  or dismiss them.
- **Switch between repos.** Each repo keeps its own terminal tabs, and the left bar marks the
  ones with something running. Add repos with Browse, and pick one of 14 themes from the
  gear icon.

Real terminals come from the optional `node-pty` dependency, prebuilt for Windows and macOS.
On Linux it needs build tools; without it, output is piped instead.

## The CLI

```bash
npx taskdeck list
```

```bash
npx taskdeck show deploy
```

```bash
npx taskdeck run deploy target=worker skipBuild --dry-run
```

```bash
npx taskdeck check
```

`check` validates the contract and lists commands in the repo that the contract doesn't
cover yet.

Scripts can add and remove repos, e.g. when creating and deleting worktrees. The contract can
live outside the repo; action `cwd`s resolve from the repo root you pass:

```bash
npx taskdeck add ../feat-login --contract ../feat-login.taskdeck.yaml
```

```bash
npx taskdeck remove ../feat-login
```

`remove` only takes the repo out of the UI and leaves its files alone. Agents have the same
pair of commands over MCP.

## The daemon

The daemon is one Node process that uses about 60 MB and no CPU while nothing runs. It
doesn't start at login: the UI, the CLI or the MCP server starts it when one of them needs it.
When a newer taskdeck connects (`@latest` picks up releases), it restarts the daemon on the
new version once no runs are going, and open UI windows reload themselves.

```bash
npx taskdeck status
```

```bash
npx taskdeck stop
```

`stop` refuses while runs are still going; `--force` stops them too. Your repo list and run
history stay in `~/.taskdeck` either way.

## Uninstall

```bash
npx taskdeck uninstall
```

This command takes taskdeck out of every client that has it and stops the daemon. It
refuses while runs are going; `--force` stops them too. Your repo list and run history stay
in `~/.taskdeck` unless you add `--purge`. It never touches the `taskdeck.yaml` files in
your repos. If you also installed taskdeck globally, run `npm rm -g taskdeck`.

To take taskdeck out of one client and leave the rest running, name it:
`npx taskdeck uninstall --copilot`.

## Status

Early, but in daily use. Today taskdeck has the contract format ([CONTRACT.md](CONTRACT.md)),
discovery helpers for npm-family scripts and PowerShell, the CLI, the local UI and the MCP
server. See [examples/](examples/) for real contracts and [ROADMAP.md](ROADMAP.md) for what
might come next.

State lives in `~/.taskdeck`: repos, run logs and proposals (`TASKDECK_HOME` moves it). The
daemon only listens on 127.0.0.1, and every API call needs the key in `~/.taskdeck`, so web
pages you visit can't drive it.

## License

Public domain ([Unlicense](LICENSE)). Do whatever you like with it.
