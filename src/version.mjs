import { readFileSync } from 'node:fs';

export const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

// a > b for plain x.y.z versions; anything unparseable counts as 0.
export function newer(a, b) {
  const pa = String(a ?? '').split('.').map(Number);
  const pb = String(b ?? '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0;
  }
  return false;
}
