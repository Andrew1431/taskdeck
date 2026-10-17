// Discovery helpers pre-fill facts for whoever writes the contract (usually an agent).
// They are optional: a repo with none of these runners still gets a contract by hand.
import { basename } from 'node:path';
import * as npm from './adapters/npm.mjs';
import * as ps1 from './adapters/ps1.mjs';

export const ADAPTERS = { npm, ps1 };

export function discoverRepo(root) {
  const catalog = { repo: basename(root), root, adapters: {}, actions: [] };
  for (const [name, adapter] of Object.entries(ADAPTERS)) {
    if (!adapter.detect(root)) continue;
    try {
      const { actions, ...meta } = adapter.discover(root);
      catalog.adapters[name] = meta;
      catalog.actions.push(...actions);
    } catch (err) {
      catalog.adapters[name] = { error: err.message };
    }
  }
  return catalog;
}
