import type { Db } from '../db/database.js';
import { canonicalLabel, stackLabels } from './labels.js';
import { newId, nowIso } from '../db/util.js';
import { addEvidence, evidenceFor, linkEvidence, toEvidenceRef, type EvidenceRef } from './evidence.js';
import type { EvidenceKind, PreferenceScope, PreferenceStatus } from './types.js';

export interface PreferenceView {
  id: string;
  title: string;
  content: string;
  scope: PreferenceScope;
  projectId: string | null;
  stack: string | null;
  scene: string | null;
  status: PreferenceStatus;
  strength: number;
  confirmedAt: string | null;
  expiresAt: string | null;
  supersededBy: string | null;
  createdAt: string;
  updatedAt: string;
  evidence: EvidenceRef[];
}

function toPreference(db: Db, row: Record<string, unknown>): PreferenceView {
  const id = String(row.id);
  return {
    id,
    title: String(row.title),
    content: String(row.content),
    scope: row.scope as PreferenceScope,
    projectId: (row.project_id as string | null) ?? null,
    stack: (row.stack as string | null) ?? null,
    scene: (row.scene as string | null) ?? null,
    status: row.status as PreferenceStatus,
    strength: Number(row.strength),
    confirmedAt: (row.confirmed_at as string | null) ?? null,
    expiresAt: (row.expires_at as string | null) ?? null,
    supersededBy: (row.superseded_by as string | null) ?? null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    evidence: evidenceFor(db, 'preference_evidence', 'preference_id', id).map(toEvidenceRef),
  };
}

export interface AddPreferenceInput {
  title: string;
  content: string;
  scope?: PreferenceScope;
  projectId?: string | null;
  stack?: string | null;
  scene?: string | null;
  /** Only "confirmed" when the user explicitly asked for a lasting rule. */
  status?: PreferenceStatus;
  evidence?: Array<{
    kind: EvidenceKind;
    relativePath?: string;
    symbol?: string;
    commitSha?: string;
    fingerprint?: string;
    snippet?: string;
    note?: string;
  }>;
}

export function addPreference(db: Db, input: AddPreferenceInput): PreferenceView {
  const id = newId('pref');
  const timestamp = nowIso();
  const status = input.status ?? 'candidate';
  const scope = input.scope ?? (input.projectId ? 'project' : 'global');
  db.transaction(() => {
    db.run(
      `INSERT INTO preference
         (id, title, content, scope, project_id, stack, scene, status, strength, confirmed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      [
        id,
        input.title,
        input.content,
        scope,
        input.projectId ?? null,
        input.stack ?? null,
        input.scene ?? null,
        status,
        status === 'confirmed' ? timestamp : null,
        timestamp,
        timestamp,
      ],
    );
    for (const ev of input.evidence ?? []) {
      const evidenceId = addEvidence(db, input.projectId ?? null, ev);
      linkEvidence(db, 'preference_evidence', 'preference_id', id, evidenceId);
    }
  });
  return getPreference(db, id)!;
}

export function getPreference(db: Db, id: string): PreferenceView | null {
  const row = db.get('SELECT * FROM preference WHERE id = ?', [id]);
  return row ? toPreference(db, row) : null;
}

export function setPreferenceStatus(db: Db, id: string, status: PreferenceStatus): PreferenceView {
  const timestamp = nowIso();
  const confirmedAt = status === 'confirmed' ? timestamp : null;
  db.run('UPDATE preference SET status = ?, confirmed_at = COALESCE(?, confirmed_at), updated_at = ? WHERE id = ?', [
    status,
    confirmedAt,
    timestamp,
    id,
  ]);
  const updated = getPreference(db, id);
  if (!updated) throw new Error(`Unknown preference: ${id}`);
  return updated;
}

/** Adds supporting evidence and increases strength; never auto-confirms. */
export function reinforcePreference(db: Db, id: string, note: string): PreferenceView {
  const preference = getPreference(db, id);
  if (!preference) throw new Error(`Unknown preference: ${id}`);
  if (preference.projectId) {
    const evidenceId = addEvidence(db, preference.projectId, { kind: 'other', note });
    linkEvidence(db, 'preference_evidence', 'preference_id', id, evidenceId);
  }
  db.run('UPDATE preference SET strength = strength + 1, updated_at = ? WHERE id = ?', [nowIso(), id]);
  return getPreference(db, id)!;
}

export function revokePreference(db: Db, id: string): PreferenceView {
  return setPreferenceStatus(db, id, 'revoked');
}

export interface PreferenceQuery {
  projectId?: string | null;
  stack?: string | null;
  scene?: string | null;
  statuses?: PreferenceStatus[];
  limit?: number;
}

/**
 * Retrieval only ever returns rules that are applicable and still in force.
 * Revoked and superseded rules are excluded by default (product doc §7.2).
 */
export function queryPreferences(db: Db, query: PreferenceQuery = {}): PreferenceView[] {
  const statuses = query.statuses ?? ['confirmed', 'candidate'];
  if (!statuses.length) return [];
  const placeholders = statuses.map(() => '?').join(',');
  const clauses: string[] = [`status IN (${placeholders})`];
  const params: Array<string | number> = [...statuses];

  // Scope semantics (product doc §4.1, §7.3): a rule only applies inside the
  // scope it was recorded for. Each clause therefore pins BOTH the scope value
  // and its target, so a project-wide rule cannot leak into a specific scene
  // and a scene rule cannot leak into a different scene.
  clauses.push("(scope = 'global' OR project_id IS NULL OR project_id = ?)");
  params.push(query.projectId ?? '');
  clauses.push('(expires_at IS NULL OR expires_at > ?)');
  params.push(nowIso());

  const limit = query.limit ?? 50;
  const rows = db.all(
    `SELECT * FROM preference WHERE ${clauses.join(' AND ')}
      ORDER BY CASE status WHEN 'confirmed' THEN 0 ELSE 1 END, strength DESC, updated_at DESC
      `,
    params,
  );
  return rows.map((row) => toPreference(db, row)).filter((preference) => {
    if (preference.scope === 'global') return true;
    if (preference.scope === 'project') return Boolean(query.projectId && preference.projectId === query.projectId);
    const kind = preference.scope;
    const requested = kind === 'scene' ? query.scene : query.stack;
    const stored = kind === 'scene' ? preference.scene : preference.stack;
    return Boolean(requested && stored && (kind === 'stack' ? stackLabels(requested) : [requested])
      .some((label) => canonicalLabel(db, kind, label) === canonicalLabel(db, kind, stored)));
  }).slice(0, limit);
}

/**
 * Counts active rules whose scope cannot be evaluated for this task (no scene
 * or stack given). Used to warn instead of silently omitting them.
 */
export function countUnresolvedScopedPreferences(
  db: Db,
  query: { projectId?: string | null; stack?: string | null; scene?: string | null },
): { scene: number; stack: number } {
  const count = (scope: 'scene' | 'stack', value?: string | null): number => {
    if (value) return 0;
    const row = db.get(
      `SELECT COUNT(*) AS c FROM preference
        WHERE status = 'confirmed' AND scope = ?
          AND (project_id IS NULL OR project_id = ?)
          AND (expires_at IS NULL OR expires_at > ?)`,
      [scope, query.projectId ?? null, nowIso()],
    );
    return Number(row?.c ?? 0);
  };
  return { scene: count('scene', query.scene), stack: count('stack', query.stack) };
}

export function listPreferences(db: Db, includeInactive = false): PreferenceView[] {
  const rows = includeInactive
    ? db.all('SELECT * FROM preference ORDER BY updated_at DESC')
    : db.all("SELECT * FROM preference WHERE status IN ('candidate','confirmed') ORDER BY updated_at DESC");
  return rows.map((row) => toPreference(db, row));
}

export function supersedePreference(db: Db, previousId: string, replacement: AddPreferenceInput): PreferenceView {
  const previous = getPreference(db, previousId);
  if (!previous) throw new Error(`Unknown preference: ${previousId}`);
  const next = addPreference(db, replacement);
  db.run("UPDATE preference SET status = 'superseded', superseded_by = ?, updated_at = ? WHERE id = ?", [
    next.id,
    nowIso(),
    previousId,
  ]);
  return next;
}

export function purgeExpiredCandidates(db: Db): number {
  const result = db.run(
    "DELETE FROM preference WHERE status = 'candidate' AND expires_at IS NOT NULL AND expires_at <= ?",
    [nowIso()],
  );
  return result.changes;
}
