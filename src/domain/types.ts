/** Shared domain vocabulary. Kept separate from DB rows so callers never
 *  depend on column names. */

export type TaskType = 'feature' | 'refactor' | 'bugfix' | 'query' | 'unknown';

export type LearningState = 'enabled' | 'disabled' | 'pending';

export type TaskStatus = 'open' | 'blocked' | 'done' | 'abandoned';

export type PreferenceStatus = 'candidate' | 'confirmed' | 'superseded' | 'revoked';

export type PreferenceScope = 'global' | 'project' | 'stack' | 'scene';

export type DecisionStatus = 'active' | 'superseded' | 'revoked';

/** Where a recorded reason actually came from. Never guess on the model's behalf. */
export type ReasonSource = 'user_explicit' | 'user_confirmed' | 'project_rule' | 'external_doc' | 'unknown';

export type StatementState = 'current' | 'historical';

export type ReviewState = 'verified' | 'needs_review' | 'stale' | 'unknown';

export type EvidenceKind = 'code' | 'commit' | 'doc' | 'user_message' | 'file' | 'other';

export interface ProjectRow {
  id: string;
  name: string;
  root_path: string;
  created_at: string;
  updated_at: string;
}

export interface ConventionRow {
  id: string;
  project_id: string;
  category: string;
  content: string;
  source: string;
  relative_path?: string | null;
  fingerprint?: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface EvidenceInput {
  kind: EvidenceKind;
  relativePath?: string | null;
  symbol?: string | null;
  commitSha?: string | null;
  fingerprint?: string | null;
  snippet?: string | null;
  note?: string | null;
}

export interface EvidenceRow extends EvidenceInput {
  id: string;
  project_id: string;
  relative_path: string | null;
  symbol: string | null;
  commit_sha: string | null;
  fingerprint: string | null;
  created_at: string;
}

export interface FeatureRow {
  id: string;
  project_id: string;
  slug: string;
  title: string;
  purpose: string | null;
  boundary: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface StatementRow {
  id: string;
  feature_id: string;
  section: string;
  content: string;
  state: StatementState;
  review_state: ReviewState;
  reviewed_at: string | null;
  superseded_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface DecisionRow {
  id: string;
  project_id: string;
  feature_id: string | null;
  task_id: string | null;
  title: string;
  choice: string;
  reason: string | null;
  reason_source: ReasonSource;
  consequence: string | null;
  scope: PreferenceScope;
  status: DecisionStatus;
  superseded_by: string | null;
  created_at: string;
}

export interface PreferenceRow {
  id: string;
  title: string;
  content: string;
  scope: PreferenceScope;
  project_id: string | null;
  stack: string | null;
  scene: string | null;
  status: PreferenceStatus;
  strength: number;
  confirmed_at: string | null;
  expires_at: string | null;
  superseded_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface TaskRow {
  id: string;
  project_id: string;
  feature_id: string | null;
  title: string;
  task_type: TaskType;
  learning_state: LearningState;
  intent: string | null;
  in_scope: string | null;
  out_of_scope: string | null;
  constraints: string | null;
  done_criteria: string | null;
  status: TaskStatus;
  outcome: string | null;
  verification: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}
