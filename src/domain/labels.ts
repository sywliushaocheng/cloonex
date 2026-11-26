import type { Db } from '../db/database.js';

export type LabelKind = 'scene' | 'stack';
export function stackLabels(value: string | null | undefined): string[] {
  if (!value) return [];
  if (value.startsWith('[')) {
    try {
      const labels: unknown = JSON.parse(value);
      if (Array.isArray(labels) && labels.every((label) => typeof label === 'string')) return labels;
    } catch { /* Existing free-text labels remain a single label. */ }
  }
  return [value];
}

export function storeStack(value: string | string[] | null | undefined): string | null {
  return Array.isArray(value) ? JSON.stringify([...new Set(value.map((label) => label.trim()).filter(Boolean))]) : value ?? null;
}
export function canonicalLabel(db: Db, kind: LabelKind, value: string): string {
  let current = value.trim().toLowerCase();
  const seen = new Set<string>();
  while (!seen.has(current)) {
    seen.add(current);
    const next = db.get('SELECT canonical FROM label_alias WHERE kind=? AND alias=?', [kind, current]);
    if (!next) return current;
    current = String(next.canonical);
  }
  throw new Error('标签别名存在循环。');
}

export function setLabelAlias(db: Db, kind: LabelKind, alias: string, canonical: string): void {
  const from = alias.trim().toLowerCase();
  const to = canonical.trim().toLowerCase();
  if (!from || !to || from === to) throw new Error('请指定不同的非空别名和标准标签。');
  db.transaction(() => {
    db.run('INSERT INTO label_alias(kind,alias,canonical) VALUES(?,?,?) ON CONFLICT(kind,alias) DO UPDATE SET canonical=excluded.canonical', [kind, from, to]);
    canonicalLabel(db, kind, from);
  });
}
