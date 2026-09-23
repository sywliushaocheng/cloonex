import type { Db } from '../db/database.js';
import { newId, nowIso } from '../db/util.js';
import { addEvidence, evidenceFor, linkEvidence, toEvidenceRef, type EvidenceRef, type EvidenceKind } from './evidence.js';
import { refreshProjectTimestamp } from './project.js';
import type { DecisionStatus, PreferenceScope, ReasonSource, ReviewState, StatementState } from './types.js';

export interface FeatureView {
  id: string;
  projectId: string;
  slug: string;
  title: string;
  purpose: string | null;
  boundary: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
}

function toFeature(row: Record<string, unknown>): FeatureView {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    slug: String(row.slug),
    title: String(row.title),
    purpose: (row.purpose as string | null) ?? null,
    boundary: (row.boundary as string | null) ?? null,
    status: String(row.status),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function slugify(title: string): string {
  const slug = title
    .trim()
    .toLowerCase()
    .replace(/[\s_/\\]+/g, '-')
    .replace(/[^a-z0-9\u4e00-\u9fa5-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return slug.length > 0 ? slug : `feature-${Date.now().toString(36)}`;
}

export interface UpsertFeatureInput {
  projectId: string;
  slug?: string;
  title: string;
  purpose?: string | null;
  boundary?: string | null;
}

export function upsertFeature(db: Db, input: UpsertFeatureInput): FeatureView {
  const slug = input.slug ? slugify(input.slug) : slugify(input.title);
  const existing = db.get('SELECT * FROM feature WHERE project_id = ? AND slug = ?', [input.projectId, slug]);
  const timestamp = nowIso();
  if (existing) {
    db.run(
      `UPDATE feature SET title = ?, purpose = COALESCE(?, purpose), boundary = COALESCE(?, boundary), updated_at = ?
       WHERE id = ?`,
      [input.title, input.purpose ?? null, input.boundary ?? null, timestamp, String(existing.id)],
    );
    refreshProjectTimestamp(db, input.projectId);
    return getFeature(db, String(existing.id))!;
  }
  const id = newId('feat');
  db.run(
    `INSERT INTO feature (id, project_id, slug, title, purpose, boundary, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
    [id, input.projectId, slug, input.title, input.purpose ?? null, input.boundary ?? null, timestamp, timestamp],
  );
  refreshProjectTimestamp(db, input.projectId);
  return getFeature(db, id)!;
}

export function getFeature(db: Db, featureId: string): FeatureView | null {
  const row = db.get('SELECT * FROM feature WHERE id = ?', [featureId]);
  return row ? toFeature(row) : null;
}

export function findFeatureBySlug(db: Db, projectId: string, slug: string): FeatureView | null {
  const row = db.get('SELECT * FROM feature WHERE project_id = ? AND slug = ?', [projectId, slugify(slug)]);
  return row ? toFeature(row) : null;
}

export function listFeatures(db: Db, projectId: string): FeatureView[] {
  return db
    .all("SELECT * FROM feature WHERE project_id = ? AND status = 'active' ORDER BY updated_at DESC", [projectId])
    .map(toFeature);
}

export interface StatementView {
  id: string;
  featureId: string;
  section: string;
  content: string;
  state: StatementState;
  reviewState: ReviewState;
  reviewedAt: string | null;
  supersededBy: string | null;
  createdAt: string;
  updatedAt: string;
  evidence: EvidenceRef[];
}

function toStatement(db: Db, row: Record<string, unknown>): StatementView {
  const id = String(row.id);
  return {
    id,
    featureId: String(row.feature_id),
    section: String(row.section),
    content: String(row.content),
    state: row.state as StatementState,
    reviewState: row.review_state as ReviewState,
    reviewedAt: (row.reviewed_at as string | null) ?? null,
    supersededBy: (row.superseded_by as string | null) ?? null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    evidence: evidenceFor(db, 'statement_evidence', 'statement_id', id).map(toEvidenceRef),
  };
}

export const STATEMENT_SECTIONS = ['purpose', 'flow', 'interaction', 'implementation', 'rule', 'dependency', 'verification'] as const;

export interface AddStatementInput {
  featureId: string;
  section: string;
  content: string;
  reviewState?: ReviewState;
  evidence?: Array<{ kind: EvidenceKind; relativePath?: string; symbol?: string; commitSha?: string; fingerprint?: string; snippet?: string; note?: string }>;
}

export function addStatement(db: Db, input: AddStatementInput): StatementView {
  const feature = getFeature(db, input.featureId);
  if (!feature) throw new Error(`Unknown feature: ${input.featureId}`);
  const id = newId('stmt');
  const timestamp = nowIso();
  db.transaction(() => {
    db.run(
      `INSERT INTO feature_statement
         (id, feature_id, section, content, state, review_state, reviewed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'current', ?, ?, ?, ?)`,
      [
        id,
        input.featureId,
        input.section,
        input.content,
        input.reviewState ?? 'unknown',
        input.reviewState === 'verified' ? timestamp : null,
        timestamp,
        timestamp,
      ],
    );
    for (const ev of input.evidence ?? []) {
      const evidenceId = addEvidence(db, feature.projectId, ev);
      linkEvidence(db, 'statement_evidence', 'statement_id', id, evidenceId);
    }
  });
  refreshProjectTimestamp(db, feature.projectId);
  return getStatement(db, id)!;
}

export function getStatement(db: Db, statementId: string): StatementView | null {
  const row = db.get('SELECT * FROM feature_statement WHERE id = ?', [statementId]);
  return row ? toStatement(db, row) : null;
}

export interface SupersedeStatementInput {
  statementId: string;
  content: string;
  section?: string;
  reviewState?: ReviewState;
  note?: string;
}

/**
 * Records a change without erasing the past: the previous statement is marked
 * historical and linked forward, the new one becomes current. This is what
 * makes "what changed, and why" answerable later.
 */
export function supersedeStatement(db: Db, input: SupersedeStatementInput): StatementView {
  const previous = getStatement(db, input.statementId);
  if (!previous) throw new Error(`Unknown statement: ${input.statementId}`);
  const feature = getFeature(db, previous.featureId);
  if (!feature) throw new Error(`Unknown feature: ${previous.featureId}`);
  const id = newId('stmt');
  const timestamp = nowIso();
  db.transaction(() => {
    db.run(
      `INSERT INTO feature_statement
         (id, feature_id, section, content, state, review_state, reviewed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'current', ?, ?, ?, ?)`,
      [
        id,
        previous.featureId,
        input.section ?? previous.section,
        input.content,
        input.reviewState ?? 'unknown',
        input.reviewState === 'verified' ? timestamp : null,
        timestamp,
        timestamp,
      ],
    );
    db.run(
      `UPDATE feature_statement
          SET state = 'historical', superseded_by = ?, review_state = 'stale', updated_at = ?
        WHERE id = ?`,
      [id, timestamp, input.statementId],
    );
    if (input.note) {
      const evidenceId = addEvidence(db, feature.projectId, { kind: 'other', note: input.note });
      linkEvidence(db, 'statement_evidence', 'statement_id', id, evidenceId);
    }
  });
  refreshProjectTimestamp(db, feature.projectId);
  return getStatement(db, id)!;
}

export function markStatementReview(db: Db, statementId: string, reviewState: ReviewState): void {
  const timestamp = nowIso();
  db.run('UPDATE feature_statement SET review_state = ?, reviewed_at = ?, updated_at = ? WHERE id = ?', [
    reviewState,
    reviewState === 'verified' ? timestamp : null,
    timestamp,
    statementId,
  ]);
}

export interface DecisionView {
  id: string;
  projectId: string;
  featureId: string | null;
  taskId: string | null;
  title: string;
  choice: string;
  reason: string | null;
  reasonSource: ReasonSource;
  consequence: string | null;
  scope: PreferenceScope;
  status: DecisionStatus;
  supersededBy: string | null;
  createdAt: string;
  evidence: EvidenceRef[];
}

function toDecision(db: Db, row: Record<string, unknown>): DecisionView {
  const id = String(row.id);
  return {
    id,
    projectId: String(row.project_id),
    featureId: (row.feature_id as string | null) ?? null,
    taskId: (row.task_id as string | null) ?? null,
    title: String(row.title),
    choice: String(row.choice),
    reason: (row.reason as string | null) ?? null,
    reasonSource: row.reason_source as ReasonSource,
    consequence: (row.consequence as string | null) ?? null,
    scope: row.scope as PreferenceScope,
    status: row.status as DecisionStatus,
    supersededBy: (row.superseded_by as string | null) ?? null,
    createdAt: String(row.created_at),
    evidence: evidenceFor(db, 'decision_evidence', 'decision_id', id).map(toEvidenceRef),
  };
}

export interface AddDecisionInput {
  projectId: string;
  featureId?: string | null;
  taskId?: string | null;
  title: string;
  choice: string;
  reason?: string | null;
  reasonSource: ReasonSource;
  consequence?: string | null;
  scope?: PreferenceScope;
  evidence?: Array<{ kind: EvidenceKind; relativePath?: string; symbol?: string; commitSha?: string; fingerprint?: string; snippet?: string; note?: string }>;
}

export function addDecision(db: Db, input: AddDecisionInput): DecisionView {
  const id = newId('dec');
  const timestamp = nowIso();
  db.transaction(() => {
    db.run(
      `INSERT INTO decision
         (id, project_id, feature_id, task_id, title, choice, reason, reason_source, consequence, scope, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
      [
        id,
        input.projectId,
        input.featureId ?? null,
        input.taskId ?? null,
        input.title,
        input.choice,
        input.reason ?? null,
        input.reasonSource,
        input.consequence ?? null,
        input.scope ?? 'project',
        timestamp,
      ],
    );
    for (const ev of input.evidence ?? []) {
      const evidenceId = addEvidence(db, input.projectId, ev);
      linkEvidence(db, 'decision_evidence', 'decision_id', id, evidenceId);
    }
  });
  refreshProjectTimestamp(db, input.projectId);
  return getDecision(db, id)!;
}

export function getDecision(db: Db, decisionId: string): DecisionView | null {
  const row = db.get('SELECT * FROM decision WHERE id = ?', [decisionId]);
  return row ? toDecision(db, row) : null;
}

export function listDecisions(db: Db, featureId: string, includeSuperseded = false): DecisionView[] {
  const rows = includeSuperseded
    ? db.all('SELECT * FROM decision WHERE feature_id = ? ORDER BY created_at ASC', [featureId])
    : db.all("SELECT * FROM decision WHERE feature_id = ? AND status = 'active' ORDER BY created_at ASC", [featureId]);
  return rows.map((row) => toDecision(db, row));
}

export function supersedeDecision(db: Db, previousId: string, replacement: Omit<AddDecisionInput, 'evidence'>): DecisionView {
  const previous = getDecision(db, previousId);
  if (!previous) throw new Error(`Unknown decision: ${previousId}`);
  const replacementView = addDecision(db, { ...replacement, projectId: previous.projectId, featureId: replacement.featureId ?? previous.featureId });
  db.run("UPDATE decision SET status = 'superseded', superseded_by = ? WHERE id = ?", [replacementView.id, previousId]);
  return replacementView;
}
