import type { Db } from '../db/database.js';
import { newId, nowIso } from '../db/util.js';
import { learningPolicy, learningStateFor, parseTaskType, type LearningPolicy } from './policy.js';
import { refreshProjectTimestamp } from './project.js';
import type { LearningState, TaskStatus, TaskType } from './types.js';

export interface TaskView {
  id: string;
  projectId: string;
  featureId: string | null;
  title: string;
  taskType: TaskType;
  learningState: LearningState;
  intent: string | null;
  inScope: string | null;
  outOfScope: string | null;
  constraints: string | null;
  doneCriteria: string | null;
  status: TaskStatus;
  outcome: string | null;
  verification: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  policy: LearningPolicy;
}

function toTaskView(row: Record<string, unknown>): TaskView {
  const taskType = row.task_type as TaskType;
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    featureId: (row.feature_id as string | null) ?? null,
    title: String(row.title),
    taskType,
    learningState: row.learning_state as LearningState,
    intent: (row.intent as string | null) ?? null,
    inScope: (row.in_scope as string | null) ?? null,
    outOfScope: (row.out_of_scope as string | null) ?? null,
    constraints: (row.constraints as string | null) ?? null,
    doneCriteria: (row.done_criteria as string | null) ?? null,
    status: row.status as TaskStatus,
    outcome: (row.outcome as string | null) ?? null,
    verification: (row.verification as string | null) ?? null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    closedAt: (row.closed_at as string | null) ?? null,
    policy: learningPolicy(taskType),
  };
}

export interface BeginTaskInput {
  projectId: string;
  title: string;
  taskType: string;
  featureId?: string | null;
  intent?: string | null;
  inScope?: string | null;
  outOfScope?: string | null;
  constraints?: string | null;
  doneCriteria?: string | null;
}

export function beginTask(db: Db, input: BeginTaskInput): TaskView {
  const taskType = parseTaskType(input.taskType);
  const id = newId('task');
  const timestamp = nowIso();
  db.run(
    `INSERT INTO task
       (id, project_id, feature_id, title, task_type, learning_state, intent, in_scope,
        out_of_scope, constraints, done_criteria, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
    [
      id,
      input.projectId,
      input.featureId ?? null,
      input.title,
      taskType,
      learningStateFor(taskType),
      input.intent ?? null,
      input.inScope ?? null,
      input.outOfScope ?? null,
      input.constraints ?? null,
      input.doneCriteria ?? null,
      timestamp,
      timestamp,
    ],
  );
  refreshProjectTimestamp(db, input.projectId);
  return getTask(db, id)!;
}

export function getTask(db: Db, taskId: string): TaskView | null {
  const row = db.get('SELECT * FROM task WHERE id = ?', [taskId]);
  return row ? toTaskView(row) : null;
}

export function findOpenTasks(db: Db, projectId: string): TaskView[] {
  return db
    .all(
      "SELECT * FROM task WHERE project_id = ? AND status IN ('open','blocked') ORDER BY updated_at DESC",
      [projectId],
    )
    .map(toTaskView);
}

export function listTasks(db: Db, projectId: string, limit = 20): TaskView[] {
  return db
    .all('SELECT * FROM task WHERE project_id = ? ORDER BY updated_at DESC LIMIT ?', [projectId, limit])
    .map(toTaskView);
}

export interface UpdateTaskInput {
  intent?: string;
  inScope?: string;
  outOfScope?: string;
  constraints?: string;
  doneCriteria?: string;
  status?: TaskStatus;
  outcome?: string;
  verification?: string;
  taskType?: string;
  featureId?: string | null;
}

export function updateTask(db: Db, taskId: string, input: UpdateTaskInput): TaskView {
  const current = getTask(db, taskId);
  if (!current) throw new Error(`Unknown task: ${taskId}`);
  const taskType = input.taskType ? parseTaskType(input.taskType) : current.taskType;
  const timestamp = nowIso();
  const status = input.status ?? current.status;
  const closedAt = status === 'done' || status === 'abandoned' ? (current.closedAt ?? timestamp) : null;

  db.run(
    `UPDATE task SET
       task_type = ?, learning_state = ?, feature_id = ?, intent = ?, in_scope = ?, out_of_scope = ?,
       constraints = ?, done_criteria = ?, status = ?, outcome = ?, verification = ?,
       updated_at = ?, closed_at = ?
     WHERE id = ?`,
    [
      taskType,
      learningStateFor(taskType),
      input.featureId !== undefined ? input.featureId : current.featureId,
      input.intent ?? current.intent,
      input.inScope ?? current.inScope,
      input.outOfScope ?? current.outOfScope,
      input.constraints ?? current.constraints,
      input.doneCriteria ?? current.doneCriteria,
      status,
      input.outcome ?? current.outcome,
      input.verification ?? current.verification,
      timestamp,
      closedAt,
      taskId,
    ],
  );
  refreshProjectTimestamp(db, current.projectId);
  return getTask(db, taskId)!;
}

/**
 * Guards are enforced at write time. They throw rather than silently dropping,
 * so a caller always learns why nothing was saved.
 */
export function assertCanWriteFeatureStatements(task: TaskView): void {
  if (!task.policy.canWriteFeatureStatements) {
    throw new Error(`任务类型 ${task.taskType} 不保存功能说明：${task.policy.rationale}`);
  }
}

export function assertCanWriteDecisions(task: TaskView): void {
  if (!task.policy.canWriteDecisions) {
    throw new Error(`任务类型 ${task.taskType} 不记录关键决定：${task.policy.rationale}`);
  }
}

export function assertCanLearnPreferences(task: TaskView): void {
  if (!task.policy.canLearnPreferences) {
    throw new Error(`任务类型 ${task.taskType} 不学习个人偏好：${task.policy.rationale}`);
  }
}

export interface CheckpointInput {
  summary: string;
  changed?: string | null;
  remaining?: string | null;
}

export function saveCheckpoint(db: Db, taskId: string, input: CheckpointInput): string {
  const task = getTask(db, taskId);
  if (!task) throw new Error(`Unknown task: ${taskId}`);
  const id = newId('ckpt');
  db.run(
    'INSERT INTO checkpoint (id, task_id, summary, changed, remaining, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [id, taskId, input.summary, input.changed ?? null, input.remaining ?? null, nowIso()],
  );
  db.run('UPDATE task SET updated_at = ? WHERE id = ?', [nowIso(), taskId]);
  refreshProjectTimestamp(db, task.projectId);
  return id;
}

export function listCheckpoints(db: Db, taskId: string) {
  return db.all('SELECT * FROM checkpoint WHERE task_id = ? ORDER BY created_at ASC', [taskId]);
}
