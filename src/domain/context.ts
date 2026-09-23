import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '../db/database.js';
import { fingerprintFile, resolveInsideProject } from './code.js';
import { listDecisions, getFeature, listFeatures } from './feature.js';
import { evidenceFor } from './evidence.js';
import { queryPreferences } from './preference.js';
import { listConventions, getProject } from './project.js';
import type { TaskView } from './task.js';

/**
 * Context assembly (product doc §9.1).
 *
 * Budgeted and explicit: rather than dumping every record, Cloonex returns the
 * sections a task actually needs and reports what it left out. Silent
 * truncation of a hard constraint is worse than a visible omission.
 */
export interface ContextBudget {
  maxChars: number;
}

export interface ContextSection {
  title: string;
  items: string[];
  omitted: number;
}

export interface TaskContext {
  project: { id: string; name: string; rootPath: string; gitHead: string | null };
  task: {
    id: string;
    title: string;
    taskType: string;
    learning: string;
    intent: string | null;
    inScope: string | null;
    outOfScope: string | null;
    constraints: string | null;
    doneCriteria: string | null;
  };
  policyRationale: string;
  sections: ContextSection[];
  budget: { maxChars: number; usedChars: number; exceeded: boolean };
  warnings: string[];
}

const DEFAULT_BUDGET = 12000;

function push(section: ContextSection, text: string, budget: { used: number; max: number }): boolean {
  if (budget.used + text.length > budget.max) {
    section.omitted += 1;
    return false;
  }
  section.items.push(text);
  budget.used += text.length;
  return true;
}

export function buildTaskContext(db: Db, task: TaskView, budget: ContextBudget = { maxChars: DEFAULT_BUDGET }): TaskContext {
  const project = getProject(db, task.projectId);
  if (!project) throw new Error(`Unknown project: ${task.projectId}`);

  const meter = { used: 0, max: budget.maxChars };
  const warnings: string[] = [];
  const sections: ContextSection[] = [];

  // 1. Project conventions
  const conventionSection: ContextSection = { title: '项目约定', items: [], omitted: 0 };
  for (const convention of listConventions(db, task.projectId)) {
    push(conventionSection, `[${convention.category}] ${convention.content}`, meter);
  }
  sections.push(conventionSection);

  // 2. Applicable preferences, with the scope visible so conflicts are debatable.
  const preferenceSection: ContextSection = { title: '适用偏好', items: [], omitted: 0 };
  for (const preference of queryPreferences(db, { projectId: task.projectId })) {
    if (preference.status === 'candidate') continue; // unconfirmed rules are not constraints
    push(preferenceSection, `[${preference.scope}] ${preference.title}：${preference.content}`, meter);
  }
  sections.push(preferenceSection);

  // 3. The feature under work, with stale flags surfaced rather than hidden.
  const featureSection: ContextSection = { title: '关联功能', items: [], omitted: 0 };
  if (task.featureId) {
    const feature = getFeature(db, task.featureId);
    if (feature) {
      push(featureSection, `${feature.title}（${feature.slug}）`, meter);
      if (feature.purpose) push(featureSection, `目的：${feature.purpose}`, meter);
      if (feature.boundary) push(featureSection, `边界：${feature.boundary}`, meter);
      const statements = db.all(
        `SELECT * FROM feature_statement WHERE feature_id = ? AND state = 'current' ORDER BY section`,
        [feature.id],
      );
      for (const statement of statements) {
        const stale = statement.review_state !== 'verified' ? `（${statement.review_state}）` : '';
        push(featureSection, `[${statement.section}]${stale} ${statement.content}`, meter);
        if (statement.review_state === 'stale') {
          warnings.push(`功能说明可能已过时，需核对代码：${String(statement.content).slice(0, 60)}`);
        }
      }
    }
  }
  sections.push(featureSection);

  // 4. Active decisions: why the current shape exists.
  const decisionSection: ContextSection = { title: '关键决定', items: [], omitted: 0 };
  if (task.featureId) {
    for (const decision of listDecisions(db, task.featureId)) {
      const reason = decision.reason ? `｜理由（${decision.reasonSource}）：${decision.reason}` : '｜理由：未知';
      push(decisionSection, `${decision.title}：${decision.choice}${reason}`, meter);
    }
  }
  sections.push(decisionSection);

  return {
    project: { id: project.id, name: project.name, rootPath: project.rootPath, gitHead: project.gitHead },
    task: {
      id: task.id,
      title: task.title,
      taskType: task.taskType,
      learning: task.learningState,
      intent: task.intent,
      inScope: task.inScope,
      outOfScope: task.outOfScope,
      constraints: task.constraints,
      doneCriteria: task.doneCriteria,
    },
    policyRationale: task.policy.rationale,
    sections,
    budget: { maxChars: budget.maxChars, usedChars: meter.used, exceeded: sections.some((s) => s.omitted > 0) },
    warnings,
  };
}

export interface StaleReport {
  statementId: string;
  featureId: string;
  section: string;
  content: string;
  reason: string;
  evidence: Array<{ id: string; relativePath: string | null; status: string; detail?: string }>;
}

/**
 * Stale detection (product doc §8.2).
 *
 * Compares the fingerprint captured when a statement was verified with the
 * current file. We re-check on demand, never by scanning the whole repo in the
 * background.
 */
export function detectStale(db: Db, projectId: string): StaleReport[] {
  const project = getProject(db, projectId);
  if (!project) throw new Error(`Unknown project: ${projectId}`);

  const rows = db.all(
    `SELECT s.* FROM feature_statement s
       JOIN feature f ON f.id = s.feature_id
      WHERE f.project_id = ? AND s.state = 'current'`,
    [projectId],
  );

  const reports: StaleReport[] = [];
  for (const row of rows) {
    const statementId = String(row.id);
    const evidence = evidenceFor(db, 'statement_evidence', 'statement_id', statementId);
    const details: StaleReport['evidence'] = [];
    let stale = false;

    for (const item of evidence) {
      const relativePath = (item.relative_path as string | null) ?? null;
      const stored = (item.fingerprint as string | null) ?? null;
      if (!relativePath || !stored) {
        details.push({ id: String(item.id), relativePath, status: 'no-fingerprint' });
        continue;
      }
      const target = resolveInsideProject(project.rootPath, relativePath);
      if (!target) {
        details.push({ id: String(item.id), relativePath, status: 'escaped-root', detail: '证据路径越出项目根目录' });
        continue;
      }
      if (!fs.existsSync(target)) {
        details.push({ id: String(item.id), relativePath, status: 'missing', detail: '文件已不存在' });
        stale = true;
        continue;
      }
      const current = fingerprintFile(target);
      if (current !== stored) {
        details.push({ id: String(item.id), relativePath, status: 'changed', detail: `指纹由 ${stored.slice(0, 14)}… 变为 ${String(current).slice(0, 14)}…` });
        stale = true;
      } else {
        details.push({ id: String(item.id), relativePath, status: 'unchanged' });
      }
    }

    if (stale) {
      reports.push({
        statementId,
        featureId: String(row.feature_id),
        section: String(row.section),
        content: String(row.content),
        reason: '关联代码在记录之后发生变化，当前说明需要重新核对。',
        evidence: details,
      });
    }
  }
  return reports;
}
