import type { Db } from '../db/database.js';
import { nowIso } from '../db/util.js';
import { fingerprintFile, resolveInsideProject } from './code.js';
import { assertCanWriteFeatureStatements, getTask, linkTaskFeature, updateTask, type TaskView } from './task.js';
import { addStatement, markStatementReview, refreshStatementEvidence, supersedeStatement, type StatementView } from './feature.js';
import type { ReviewState } from './types.js';

export interface FinalizeInput {
  task: TaskView;
  outcome?: string | null;
  verification?: string | null;
  /** Statements to record as verified now; they inherit the task's code state. */
  statements?: Array<{ featureId: string; section: string; content: string; relativePaths?: string[]; topicKey?: string }>;
  knowledgeMode?: 'feature' | 'summary';
}

export interface FinalizeResult {
  taskId: string;
  statements: StatementView[];
  skipped: number;
  codeState: Array<{ relativePath: string; fingerprint: string }>;
  warnings: string[];
  refreshed: number;
}

/**
 * Finalises a task: records verified statements and captures the code state
 * they depend on, so later runs can tell whether a statement went stale.
 *
 * Only "verified" statements capture fingerprints. Recording a fingerprint for
 * something nobody checked would make stale detection lie.
 *
 * Repeat safety (product doc §13.2): finalisation is refused once a task is
 * already done, and a statement whose content already exists as current for
 * that feature is skipped instead of duplicated. Legitimate updates go through
 * supersedeStatement, which preserves history instead of producing two
 * conflicting "current" claims.
 */
export function finalizeTask(db: Db, input: FinalizeInput): FinalizeResult {
  const task = getTask(db, input.task.id);
  if (!task) throw new Error('找不到任务。');

  if (task.status === 'done') {
    throw new Error(
      `任务已完成（${task.id}），重复结束会产生矛盾记录。如需修正说明，请使用 supersede 流程更新功能说明。`,
    );
  }
  if (task.status === 'abandoned') {
    throw new Error(`任务已放弃（${task.id}），不能写入完成记录。`);
  }

  const warnings: string[] = [];
  const statements: StatementView[] = [];
  const codeState: Array<{ relativePath: string; fingerprint: string }> = [];
  let skipped = 0;
  let refreshed = 0;

  if (input.statements && input.statements.length > 0) {
    assertCanWriteFeatureStatements(task);
    if (input.knowledgeMode === 'summary') throw new Error('summary 模式不能同时提交功能说明。');
  }

  const projectRow = db.get('SELECT root_path FROM project WHERE id = ?', [task.projectId]);
  const projectRoot = projectRow?.root_path as string | undefined;
  if (!projectRoot) throw new Error(`Unknown project: ${task.projectId}`);

  db.transaction(() => {
    for (const item of input.statements ?? []) {
      linkTaskFeature(db, task.id, item.featureId);
      const existing = db.get(
        `SELECT id FROM feature_statement
          WHERE feature_id = ? AND section = ? AND content = ? AND state = 'current'`,
        [item.featureId, item.section, item.content],
      );
      if (existing) {
        codeState.push(...refreshStatementEvidence(db, String(existing.id), item.relativePaths, '结束任务时重新核对相同说明'));
        refreshed += 1;
        skipped += 1;
        continue;
      }

      const relativePaths = item.relativePaths ?? [];
      const evidence: Array<{ kind: 'code'; relativePath?: string; fingerprint?: string }> = [];
      for (const relativePath of relativePaths) {
        const absolute = resolveInsideProject(projectRoot, relativePath);
        if (!absolute) {
          warnings.push(`证据路径越出项目根目录，已忽略：${relativePath}`);
          continue;
        }
        const fingerprint = fingerprintFile(absolute);
        if (!fingerprint) {
          warnings.push(`无法读取文件，未记录指纹：${relativePath}`);
          continue;
        }
        evidence.push({ kind: 'code', relativePath, fingerprint });
        codeState.push({ relativePath, fingerprint });
      }

      const statement = addStatement(db, {
        featureId: item.featureId,
        section: item.section,
        content: item.content,
        reviewState: relativePaths.length > evidence.length ? 'needs_review' : 'verified',
        topicKey: item.topicKey,
        evidence,
      });
      statements.push(statement);
    }

    for (const state of codeState) {
      db.run(
        `INSERT INTO task_code_state (id, task_id, project_id, relative_path, fingerprint, captured_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [`cs_${Math.random().toString(36).slice(2, 12)}`, task.id, task.projectId, state.relativePath, state.fingerprint, nowIso()],
      );
    }
    if (task.policy.canWriteFeatureStatements && !input.statements?.length && input.knowledgeMode !== 'summary') {
      warnings.push('本次没有沉淀功能说明。如仅需任务总结，请明确选择 knowledgeMode=summary。');
    }
    updateTask(db, task.id, { status: 'done', outcome: input.outcome ?? undefined, verification: input.verification ?? undefined });
  });

  return { taskId: task.id, statements, skipped, codeState, warnings, refreshed };
}

/** Records that a human/model re-checked a statement against current code. */
export function reviewStatement(db: Db, statementId: string, state: ReviewState, relativePaths?: string[], note?: string): void {
  if (state === 'verified') refreshStatementEvidence(db, statementId, relativePaths, note);
  else {
    if (!db.get('SELECT id FROM feature_statement WHERE id=?', [statementId])) throw new Error('找不到说明。');
    markStatementReview(db, statementId, state);
  }
}

export { supersedeStatement };
