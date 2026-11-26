import type { Db } from '../db/database.js';
import { fingerprintFile, resolveInsideProject } from './code.js';
import { evidenceFor } from './evidence.js';
import { nowIso } from '../db/util.js';
import fs from 'node:fs';

export interface Freshness {
  status: 'unchanged' | 'changed' | 'missing' | 'untracked' | 'unreadable';
  checkedAt: string;
  evidence: Array<{ id: string; relativePath: string | null; status: string; recorded: string | null; current: string | null }>;
}

/** A cache belongs to one read, never to a later query after a file edit. */
export function statementFreshness(db: Db, statementId: string, cache = new Map<string, string | null>()): Freshness {
  const owner = db.get(`SELECT p.root_path FROM feature_statement s JOIN feature f ON s.feature_id=f.id
    JOIN project p ON p.id=f.project_id WHERE s.id=?`, [statementId]);
  if (!owner) throw new Error(`Unknown statement: ${statementId}`);
  const details: Freshness['evidence'] = [];
  for (const row of evidenceFor(db, 'statement_evidence', 'statement_id', statementId)) {
    const relativePath = row.relative_path as string | null;
    const recorded = row.fingerprint as string | null;
    if (!relativePath || !recorded) continue;
    const absolute = resolveInsideProject(String(owner.root_path), relativePath);
    let current: string | null = null;
    let status = 'unreadable';
    if (absolute) {
      if (!cache.has(absolute)) cache.set(absolute, fingerprintFile(absolute));
      current = cache.get(absolute) ?? null;
      status = current === null ? (fs.existsSync(absolute) ? 'unreadable' : 'missing') : current === recorded ? 'unchanged' : 'changed';
    }
    details.push({ id: String(row.id), relativePath, recorded, current, status });
  }
  const status = details.length === 0 ? 'untracked'
    : details.some((e) => e.status === 'missing') ? 'missing'
      : details.some((e) => e.status === 'unreadable') ? 'unreadable'
        : details.some((e) => e.status === 'changed') ? 'changed' : 'unchanged';
  return { status, checkedAt: nowIso(), evidence: details };
}
