# taskdeck

Every repo grows commands you forget: `pnpm run deploy worker --skip-build`,
`.\launch-two.ps1 -Count 3 -Manual`, "edit tfvars, then apply, then deploy". Your AI
assistant tells you once, and it's gone by the time you open a terminal.

taskdeck gives each repo one `taskdeck.yaml` listing those commands: documented, typed
and marked by risk. It doesn't matter whether they're npm scripts, PowerShell, make or
your own CLI. You (or your agent) run them from one place.

## Set up a repo: point your agent at this file

Tell your coding agent (Claude Code, Copilot, Cursor...):

> Read https://github.com/Andrew1431/taskdeck/blob/main/AGENT_SETUP.md and set up taskdeck for this repo.

It discovers the commands, reads your docs, writes `taskdeck.yaml` and checks it.

## Use it

Open the UI. It starts a small background daemon on `127.0.0.1` and adds the current repo:

```bash
npx taskdeck ui
```

Every action is a form: fill in the blanks, watch the exact command update, press Run and
watch it in a real terminal (colors, progress bars, prompts you can type into), or send it
to your own terminal with "Open in my terminal". Runs keep going if you close the tab.
(Real terminals come from the optional `node-pty` dependency; without it, output is piped.) High-risk actions ask you to confirm. Workflows are checklists. Things
your agent suggested wait under "Waiting for you" until you run or dismiss them.

Give your agent the same deck over MCP (Claude Code shown; any MCP client works):

```bash
claude mcp add taskdeck --scope user -- npx -y taskdeck mcp
```

The agent can then list and describe actions and run the ones the contract allows
(`agent: run`). Anything risky becomes a proposal in your UI instead of a command in chat
that you'll have forgotten by tomorrow.

From a terminal:

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

`check` validates the contract and lists commands in the repo the contract doesn't cover yet.

## Status

Early prototype. Today: the contract format ([CONTRACT.md](CONTRACT.md)), discovery
helpers for npm-family scripts and PowerShell, the CLI, the local web UI and the MCP
server. See [examples/](examples/) for real contracts.

State lives in `~/.taskdeck` (repos, run logs, proposals; `TASKDECK_HOME` overrides it).
The daemon only listens on 127.0.0.1 and every API call needs the token in
`~/.taskdeck/daemon.json`, so web pages you visit can't drive it.

## License

Public domain ([Unlicense](LICENSE)). Do whatever you like with it.
