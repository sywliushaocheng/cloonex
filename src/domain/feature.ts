import type { Db } from '../db/database.js';
import { newId, nowIso } from '../db/util.js';
import { addEvidence, evidenceFor, linkEvidence, toEvidenceRef, type EvidenceRef, type EvidenceKind } from './evidence.js';
import { refreshProjectTimestamp } from './project.js';
import type { DecisionStatus, PreferenceScope, ReasonSource, ReviewState, StatementState } from './types.js';
import { fingerprintFile, resolveInsideProject } from './code.js';

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
  aliases: string[];
}

function toFeature(row: Record<string, unknown>, db: Db): FeatureView {
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
    aliases: db.all('SELECT alias FROM feature_alias WHERE feature_id=? ORDER BY alias', [String(row.id)]).map((r) => String(r.alias)),
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
  return row ? toFeature(row, db) : null;
}

export function findFeatureBySlug(db: Db, projectId: string, slug: string): FeatureView | null {
  const row = db.get('SELECT * FROM feature WHERE project_id = ? AND slug = ?', [projectId, slugify(slug)]);
  return row ? toFeature(row, db) : null;
}

/** Lookup must never replace an existing human-readable title with its slug. */
export function ensureFeature(db: Db, projectId: string, slug: string): FeatureView {
  return findFeatureBySlug(db, projectId, slug) ?? upsertFeature(db, { projectId, slug, title: slug });
}

export function listFeatures(db: Db, projectId: string): FeatureView[] {
  return db
    .all("SELECT * FROM feature WHERE project_id = ? AND status = 'active' ORDER BY updated_at DESC", [projectId])
    .map((row) => toFeature(row, db));
}

export function setFeatureAliases(db: Db, featureId: string, aliases: string[]): void {
  if (!getFeature(db, featureId)) throw new Error('找不到功能。');
  if (aliases.some((alias) => !alias.trim())) throw new Error('别名不能为空。');
  db.transaction(() => {
    db.run('DELETE FROM feature_alias WHERE feature_id=?', [featureId]);
    for (const alias of new Set(aliases.map((value) => value.trim()))) {
      db.run('INSERT INTO feature_alias(feature_id,alias) VALUES(?,?)', [featureId, alias]);
    }
  });
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
  topicKey: string | null;
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
    topicKey: (row.topic_key as string | null) ?? null,
  };
}

export const STATEMENT_SECTIONS = ['purpose', 'flow', 'interaction', 'implementation', 'rule', 'dependency', 'verification'] as const;

export interface AddStatementInput {
  featureId: string;
  section: string;
  content: string;
  reviewState?: ReviewState;
  topicKey?: string | null;
  evidence?: Array<{ kind: EvidenceKind; relativePath?: string; symbol?: string; commitSha?: string; fingerprint?: string; snippet?: string; note?: string }>;
}

export function addStatement(db: Db, input: AddStatementInput): StatementView {
  const feature = getFeature(db, input.featureId);
  if (!feature) throw new Error(`Unknown feature: ${input.featureId}`);
  const id = newId('stmt');
  const timestamp = nowIso();
  db.transaction(() => {
    if (input.topicKey && db.get("SELECT id FROM feature_statement WHERE feature_id=? AND topic_key=? AND state='current'", [input.featureId, input.topicKey])) {
      throw new Error('该主题已有当前说明，请显式替代旧说明。');
    }
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
    if (input.topicKey) db.run('UPDATE feature_statement SET topic_key=? WHERE id=?', [input.topicKey, id]);
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
  topicKey?: string | null;
}

/**
 * Records a change without erasing the past: the previous statement is marked
 * historical and linked forward, the new one becomes current. This is what
 * makes "what changed, and why" answerable later.
 */
export function supersedeStatement(db: Db, input: SupersedeStatementInput): StatementView {
  const previous = getStatement(db, input.statementId);
  if (!previous) throw new Error(`Unknown statement: ${input.statementId}`);
  if (previous.state !== 'current') throw new Error('只能替代当前说明。');
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
    const topicKey = input.topicKey ?? previous.topicKey;
    if (topicKey) {
      if (db.get("SELECT id FROM feature_statement WHERE feature_id=? AND topic_key=? AND state='current' AND id<>?", [previous.featureId, topicKey, id])) {
        throw new Error('该主题已存在其他当前说明。');
      }
      db.run('UPDATE feature_statement SET topic_key=? WHERE id=?', [topicKey, id]);
    }
    if (input.note) {
      const evidenceId = addEvidence(db, feature.projectId, { kind: 'other', note: input.note });
      linkEvidence(db, 'statement_evidence', 'statement_id', id, evidenceId);
    }
  });
  refreshProjectTimestamp(db, feature.projectId);
  return getStatement(db, id)!;
}

/** Rebase only after an explicit re-review. Old evidence remains immutable in
 * the review audit trail, so verification never erases the previous baseline. */
export function refreshStatementEvidence(db: Db, statementId: string, relativePaths?: string[], note?: string): Array<{relativePath: string; fingerprint: string}> {
  const statement = getStatement(db, statementId);
  if (!statement || statement.state !== 'current') throw new Error('只能复核当前说明。');
  const project = db.get(`SELECT p.root_path,f.project_id FROM feature f JOIN project p ON p.id=f.project_id WHERE f.id=?`, [statement.featureId]);
  if (!project) throw new Error('找不到关联项目。');
  const paths = [...new Set([...(relativePaths ?? []), ...statement.evidence.filter((e) => e.fingerprint && e.relativePath).map((e) => e.relativePath!)])];
  const baselines = paths.map((relativePath) => {
    const absolute = resolveInsideProject(String(project.root_path), relativePath);
    const fingerprint = absolute ? fingerprintFile(absolute) : null;
    if (!fingerprint) throw new Error(`无法核对证据文件：${relativePath}。请先迁移路径或显式替代说明。`);
    return { relativePath, fingerprint };
  });
  db.transaction(() => {
    db.run(`INSERT INTO statement_review(id,statement_id,review_state,reviewed_at,evidence_json,note,created_at)
      VALUES(?,?,?,?,?,?,?)`, [newId('review'), statementId, statement.reviewState, statement.reviewedAt,
      JSON.stringify(statement.evidence), note ?? null, nowIso()]);
    for (const baseline of baselines) {
      db.run(`DELETE FROM statement_evidence WHERE statement_id=? AND evidence_id IN
        (SELECT id FROM evidence WHERE relative_path=? AND fingerprint IS NOT NULL)`, [statementId, baseline.relativePath]);
      const evidenceId = addEvidence(db, String(project.project_id), { kind: 'code', ...baseline });
      linkEvidence(db, 'statement_evidence', 'statement_id', statementId, evidenceId);
    }
    markStatementReview(db, statementId, 'verified');
  });
  return baselines;
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
  if (previous.status !== 'active' || previous.projectId !== replacement.projectId) throw new Error('只能替代本项目的当前决定。');
  if (replacement.featureId && getFeature(db, replacement.featureId)?.projectId !== previous.projectId) throw new Error('功能不属于该项目。');
  return db.transaction(() => {
    const replacementView = addDecision(db, { ...replacement, projectId: previous.projectId, featureId: replacement.featureId ?? previous.featureId });
    db.run("UPDATE decision SET status = 'superseded', superseded_by = ? WHERE id = ?", [replacementView.id, previousId]);
    return replacementView;
  });
}
