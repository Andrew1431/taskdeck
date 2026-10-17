// Opens the UI in its own window (Chrome/Edge app mode: no tabs or address bar), falling
// back to the default browser when neither is installed.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

function candidates() {
  const env = process.env;
  if (process.platform === 'win32') {
    const roots = [env.LOCALAPPDATA, env.PROGRAMFILES, env['PROGRAMFILES(X86)']].filter(Boolean);
    return ['Google\\Chrome\\Application\\chrome.exe', 'Microsoft\\Edge\\Application\\msedge.exe', 'BraveSoftware\\Brave-Browser\\Application\\brave.exe']
      .flatMap((p) => roots.map((r) => join(r, p)));
  }
  if (process.platform === 'darwin') {
    return ['Google Chrome', 'Microsoft Edge', 'Brave Browser', 'Chromium'].map((n) => `/Applications/${n}.app/Contents/MacOS/${n}`);
  }
  const dirs = (env.PATH ?? '').split(delimiter);
  return ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'brave-browser']
    .flatMap((b) => dirs.map((d) => join(d, b)));
}

export function openUi(url, { appMode = true } = {}) {
  const browser = appMode && candidates().find((p) => existsSync(p));
  if (browser) {
    spawn(browser, [`--app=${url}`, '--window-size=1280,860'], { detached: true, stdio: 'ignore' }).unref();
    return 'window';
  }
  const opener = process.platform === 'win32' ? ['cmd.exe', ['/c', 'start', '""', `"${url}"`]] : [process.platform === 'darwin' ? 'open' : 'xdg-open', [url]];
  spawn(opener[0], opener[1], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true }).unref();
  return 'browser';
}
