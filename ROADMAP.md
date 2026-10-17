# Roadmap

Ideas, not promises. Roughly in the order they'd be worth doing.

## Tray icon

A system tray icon so taskdeck feels like part of the desktop: open the UI, see what's
running and stop it, stop the daemon, quit.

- A small native helper (Rust `tray-icon` or Go `systray`, a few MB), not a full app. It
  has no webview: it talks to the daemon's HTTP API with the token in `~/.taskdeck/daemon.json`,
  and "Open taskdeck" launches the same app-mode window `taskdeck ui` does.
- Shipped the way esbuild ships its binary: CI builds one per platform
  (win32-x64, darwin-arm64, darwin-x64, linux-x64), each published as its own npm package
  (`@taskdeck/tray-<os>-<cpu>`) with `os`/`cpu` fields, listed in `optionalDependencies`
  so npm installs only the matching one. `taskdeck tray` starts it.
- Files npm installs don't carry the "downloaded from the internet" mark, so SmartScreen
  and Gatekeeper don't block an unsigned binary. Apple Silicon still needs an ad-hoc
  signature, which the Rust linker adds for free.
- Optional: start at login.

## Installable desktop app

Only if people outside the Node world want taskdeck: a Tauri (or Electron) app with an
installer, owning the daemon and the tray.

- Windows signing: free through the SignPath Foundation for open-source projects;
  otherwise Certum's open-source certificate or Azure Trusted Signing. Unsigned works but
  shows "Windows protected your PC" until it builds reputation.
- macOS: notarizing needs Apple's developer program ($99/year). Unsigned apps have to be
  allowed in System Settings → Privacy & Security.
- Microsoft Store signs apps itself and may be the cheapest polished route on Windows.
- Tauri's updater signs updates with its own free key pair.

## Smaller things

- Open runs an agent starts in the terminal dock automatically.
- Tests for the contract parser, argv building and Windows quoting.
- Discovery helpers beyond npm scripts and PowerShell (make, just, cargo, docker compose).
