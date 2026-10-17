// Markdown view of catalogs: what a human (or an agent) would see before any UI exists.
export function renderReport(catalogs) {
  const out = ['# Discovered actions', ''];
  for (const c of catalogs) {
    out.push(`## ${c.repo}`, '');
    for (const [name, meta] of Object.entries(c.adapters)) {
      out.push(`- adapter **${name}**${meta.error ? `: error: ${meta.error}` : meta.packageManager ? ` (package manager: ${meta.packageManager})` : ''}`);
    }
    out.push('');
    const groups = Map.groupBy ? Map.groupBy(c.actions, (a) => `${a.adapter} · ${a.group}`) : group(c.actions);
    for (const [g, actions] of groups) {
      out.push(`### ${g}`, '');
      for (const a of actions) {
        const tags = [a.risk === 'high' && '⚠ high-risk', a.kind !== 'task' && a.kind].filter(Boolean);
        out.push(`- **${a.name}**${tags.length ? ` _(${tags.join(', ')})_` : ''} — \`${[a.run.command, ...a.run.args].join(' ')}\``);
        if (a.description) out.push(`  - ${firstLines(a.description, 2)}`);
        else if (a.script) out.push(`  - runs \`${a.script}\` (no docs found)`);
        else out.push('  - (no docs found)');
        for (const p of a.params) {
          const bits = [p.type === 'enum' ? `one of ${p.choices.join('|')}` : p.type];
          if (p.default !== null && p.default !== undefined && p.default !== false) bits.push(`default ${typeof p.default === 'object' ? p.default.expression : JSON.stringify(p.default)}`);
          if (p.required) bits.push('required');
          if (p.inferred) bits.push('inferred');
          if (p.risk === 'high') bits.push('⚠ high-risk when set');
          out.push(`  - \`${p.name}\` (${bits.join(', ')})${p.description ? `: ${p.description}` : ''}`);
        }
        if (a.env.length) out.push(`  - env: ${a.env.map((e) => (e.secret ? `🔒${e.name}` : e.name)).join(', ')}`);
        if (a.calls?.length) out.push(`  - calls: ${a.calls.join(', ')}`);
        for (const n of a.notes) out.push(`  - note: ${n}`);
      }
      out.push('');
    }
  }
  return out.join('\n');
}

function firstLines(text, n) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.slice(0, n).join(' ') + (lines.length > n ? ' …' : '');
}

function group(items) {
  const m = new Map();
  for (const a of items) {
    const k = `${a.adapter} · ${a.group}`;
    m.set(k, [...(m.get(k) ?? []), a]);
  }
  return m;
}
