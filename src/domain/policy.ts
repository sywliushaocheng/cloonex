import type { LearningState, TaskType } from './types.js';

/**
 * Learning policy (product doc §7.1).
 *
 * This is deliberately code, not prompt text: a bugfix task must not create
 * preference records even if a model or hook tries to. Reading existing project
 * context stays allowed for every task type.
 */
export interface LearningPolicy {
  /** May existing conventions / preferences / features be read? */
  canReadContext: boolean;
  /** May this task create or update feature statements? */
  canWriteFeatureStatements: boolean;
  /** May this task record decisions (choice + reason)? */
  canWriteDecisions: boolean;
  /** May this task create candidate preferences? */
  canLearnPreferences: boolean;
  /** Human-readable reason, surfaced in tool output and CLI. */
  rationale: string;
}

const POLICIES: Record<TaskType, LearningPolicy> = {
  feature: {
    canReadContext: true,
    canWriteFeatureStatements: true,
    canWriteDecisions: true,
    canLearnPreferences: true,
    rationale: '新功能开发：记录功能知识与有依据的候选偏好。',
  },
  refactor: {
    canReadContext: true,
    canWriteFeatureStatements: true,
    canWriteDecisions: true,
    canLearnPreferences: true,
    rationale: '功能重构：记录功能知识，并生成有依据的候选偏好。',
  },
  bugfix: {
    canReadContext: true,
    canWriteFeatureStatements: false,
    canWriteDecisions: false,
    canLearnPreferences: false,
    rationale: 'Bug 修复：可以使用已有约定，但不产生偏好或独立修复档案。',
  },
  query: {
    canReadContext: true,
    canWriteFeatureStatements: true,
    canWriteDecisions: false,
    canLearnPreferences: false,
    rationale: '查询与功能梳理：不从查询行为推断偏好；可保存带核对时间的功能说明。',
  },
  unknown: {
    canReadContext: true,
    canWriteFeatureStatements: false,
    canWriteDecisions: false,
    canLearnPreferences: false,
    rationale: '任务类型不明确：默认关闭记录，明确划分新功能或重构部分后再写入。',
  },
};

export function learningPolicy(taskType: TaskType): LearningPolicy {
  return POLICIES[taskType] ?? POLICIES.unknown;
}

export function learningStateFor(taskType: TaskType): LearningState {
  if (taskType === 'feature' || taskType === 'refactor') return 'enabled';
  if (taskType === 'bugfix' || taskType === 'query') return 'disabled';
  return 'pending';
}

export function parseTaskType(input: string | undefined | null): TaskType {
  const value = (input ?? '').trim().toLowerCase();
  if (value === 'feature' || value === 'new-feature' || value === '新功能') return 'feature';
  if (value === 'refactor' || value === '重构') return 'refactor';
  if (['bugfix', 'bug-fix', 'fix', '修复', 'bug修复'].includes(value)) return 'bugfix';
  if (['query', '查询', '梳理'].includes(value)) return 'query';
  return 'unknown';
}

/** Reason labels: never let a model claim the user's reason for itself. */
export const REASON_SOURCES = [
  'user_explicit',
  'user_confirmed',
  'project_rule',
  'external_doc',
  'unknown',
] as const;

export type ReasonSourceValue = (typeof REASON_SOURCES)[number];

export function parseReasonSource(input: string | undefined | null): ReasonSourceValue {
  const value = (input ?? '').trim().toLowerCase();
  return (REASON_SOURCES as readonly string[]).includes(value) ? (value as ReasonSourceValue) : 'unknown';
}
