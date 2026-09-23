import type { Db } from '../db/database.js';
import { newId, nowIso } from '../db/util.js';
import type { EvidenceInput, EvidenceKind } from './types.js';
export type { EvidenceKind };

/** projectId is null for evidence that supports a global (cross-project) rule. */
export function addEvidence(db: Db, projectId: string | null, input: EvidenceInput): string {
  const id = newId('ev');
  db.run(
    `INSERT INTO evidence
       (id, project_id, kind, relative_path, symbol, commit_sha, fingerprint, snippet, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      projectId ?? null,
      input.kind,
      input.relativePath ?? null,
      input.symbol ?? null,
      input.commitSha ?? null,
      input.fingerprint ?? null,
      input.snippet ?? null,
      input.note ?? null,
      nowIso(),
    ],
  );
  return id;
}

export function linkEvidence(
  db: Db,
  table: 'statement_evidence' | 'decision_evidence' | 'preference_evidence',
  ownerColumn: string,
  ownerId: string,
  evidenceId: string,
): void {
  db.run(`INSERT OR IGNORE INTO ${table} (${ownerColumn}, evidence_id) VALUES (?, ?)`, [ownerId, evidenceId]);
}

export function evidenceFor(db: Db, table: string, ownerColumn: string, ownerId: string) {
  return db.all(
    `SELECT e.* FROM evidence e
       JOIN ${table} l ON l.evidence_id = e.id
      WHERE l.${ownerColumn} = ?
      ORDER BY e.created_at ASC`,
    [ownerId],
  );
}

export interface EvidenceRef {
  id: string;
  kind: EvidenceKind;
  relativePath: string | null;
  symbol: string | null;
  commitSha: string | null;
  fingerprint: string | null;
  snippet: string | null;
  note: string | null;
  createdAt: string;
}

export function toEvidenceRef(row: Record<string, unknown>): EvidenceRef {
  return {
    id: String(row.id),
    kind: String(row.kind) as EvidenceKind,
    relativePath: (row.relative_path as string | null) ?? null,
    symbol: (row.symbol as string | null) ?? null,
    commitSha: (row.commit_sha as string | null) ?? null,
    fingerprint: (row.fingerprint as string | null) ?? null,
    snippet: (row.snippet as string | null) ?? null,
    note: (row.note as string | null) ?? null,
    createdAt: String(row.created_at),
  };
}
