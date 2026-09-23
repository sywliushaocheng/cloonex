-- Cloonex schema. Every migration is idempotent and append-only.

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- Projects
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS project (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  root_path   TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- Project-level conventions: stack, layering, naming, testing, design rules.
CREATE TABLE IF NOT EXISTS project_convention (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  category    TEXT NOT NULL,
  content     TEXT NOT NULL,
  source      TEXT NOT NULL,
  status      TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_convention_project
  ON project_convention(project_id, status, category);

-- ---------------------------------------------------------------------------
-- Evidence: what proof exists for a claim, tied to a code state
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS evidence (
  id            TEXT PRIMARY KEY,
  project_id    TEXT REFERENCES project(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,
  relative_path TEXT,
  symbol        TEXT,
  commit_sha    TEXT,
  fingerprint   TEXT,
  snippet       TEXT,
  note          TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_evidence_project_path
  ON evidence(project_id, relative_path);

-- ---------------------------------------------------------------------------
-- Features: stable identity + current reviewed statement
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS feature (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  slug         TEXT NOT NULL,
  title        TEXT NOT NULL,
  purpose      TEXT,
  boundary     TEXT,
  status       TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  UNIQUE (project_id, slug)
);

-- Interaction / flow statements attached to a feature.
CREATE TABLE IF NOT EXISTS feature_statement (
  id             TEXT PRIMARY KEY,
  feature_id     TEXT NOT NULL REFERENCES feature(id) ON DELETE CASCADE,
  section        TEXT NOT NULL,
  content        TEXT NOT NULL,
  state          TEXT NOT NULL,
  review_state   TEXT NOT NULL,
  reviewed_at    TEXT,
  superseded_by  TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_statement_feature
  ON feature_statement(feature_id, review_state, section);

-- Evidence for a statement; also used for stale detection.
CREATE TABLE IF NOT EXISTS statement_evidence (
  statement_id TEXT NOT NULL REFERENCES feature_statement(id) ON DELETE CASCADE,
  evidence_id  TEXT NOT NULL REFERENCES evidence(id) ON DELETE CASCADE,
  PRIMARY KEY (statement_id, evidence_id)
);

-- ---------------------------------------------------------------------------
-- Decisions: the chosen option, the reason, and where the reason came from
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS decision (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  feature_id     TEXT REFERENCES feature(id) ON DELETE SET NULL,
  task_id        TEXT,
  title          TEXT NOT NULL,
  choice         TEXT NOT NULL,
  reason         TEXT,
  reason_source  TEXT NOT NULL,
  consequence    TEXT,
  scope          TEXT NOT NULL,
  status         TEXT NOT NULL,
  superseded_by  TEXT,
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_decision_feature
  ON decision(feature_id, status);
CREATE INDEX IF NOT EXISTS idx_decision_project
  ON decision(project_id, created_at);

CREATE TABLE IF NOT EXISTS decision_evidence (
  decision_id TEXT NOT NULL REFERENCES decision(id) ON DELETE CASCADE,
  evidence_id TEXT NOT NULL REFERENCES evidence(id) ON DELETE CASCADE,
  PRIMARY KEY (decision_id, evidence_id)
);

-- ---------------------------------------------------------------------------
-- Preferences: separate from project conventions and one-off task rules
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS preference (
  id             TEXT PRIMARY KEY,
  title          TEXT NOT NULL,
  content        TEXT NOT NULL,
  scope          TEXT NOT NULL,
  project_id     TEXT REFERENCES project(id) ON DELETE CASCADE,
  stack          TEXT,
  scene          TEXT,
  status         TEXT NOT NULL,
  strength       INTEGER NOT NULL DEFAULT 1,
  confirmed_at   TEXT,
  expires_at     TEXT,
  superseded_by  TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_preference_scope
  ON preference(scope, status, project_id);

CREATE TABLE IF NOT EXISTS preference_evidence (
  preference_id TEXT NOT NULL REFERENCES preference(id) ON DELETE CASCADE,
  evidence_id   TEXT NOT NULL REFERENCES evidence(id) ON DELETE CASCADE,
  PRIMARY KEY (preference_id, evidence_id)
);

-- ---------------------------------------------------------------------------
-- Tasks: intent, scope, completion criteria, progress
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS task (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  feature_id     TEXT REFERENCES feature(id) ON DELETE SET NULL,
  title          TEXT NOT NULL,
  task_type      TEXT NOT NULL,
  learning_state TEXT NOT NULL,
  intent         TEXT,
  in_scope       TEXT,
  out_of_scope   TEXT,
  constraints    TEXT,
  done_criteria  TEXT,
  status         TEXT NOT NULL,
  outcome        TEXT,
  verification   TEXT,
  stack          TEXT,
  scene          TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  closed_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_task_project_status
  ON task(project_id, status, updated_at);

CREATE TABLE IF NOT EXISTS checkpoint (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  summary     TEXT NOT NULL,
  changed     TEXT,
  remaining   TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_checkpoint_task
  ON checkpoint(task_id, created_at);

-- Code state captured at task finalisation, used for later stale detection.
CREATE TABLE IF NOT EXISTS task_code_state (
  id            TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  project_id    TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  relative_path TEXT NOT NULL,
  fingerprint   TEXT NOT NULL,
  symbol        TEXT,
  captured_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_code_state_project
  ON task_code_state(project_id, relative_path);
