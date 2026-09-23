import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, describe, before, after } from 'node:test';
import { Db } from '../src/db/database.js';
import { SCHEMA_SQL } from '../src/db/schema.js';
import { ensureProject, addConvention, listConventions } from '../src/domain/project.js';
import { beginTask, assertCanLearnPreferences, assertCanWriteDecisions, saveCheckpoint, updateTask } from '../src/domain/task.js';
import { addDecision, addStatement, getFeature, listDecisions, listFeatures, supersedeStatement, upsertFeature } from '../src/domain/feature.js';
import { addPreference, listPreferences, queryPreferences, revokePreference, setPreferenceStatus } from '../src/domain/preference.js';
import { buildTaskContext, detectStale } from '../src/domain/context.js';
import { finalizeTask } from '../src/domain/finalize.js';
import { resolveFeature } from '../src/domain/feature-query.js';
import { exportTaskMarkdown } from '../src/export/markdown.js';

let tmpRoot: string;
let projectRoot: string;
let db: Db;

function freshDb(): Db {
  const dbPath = path.join(tmpRoot, `test-${Math.random().toString(36).slice(2)}.sqlite`);
  const instance = new Db(dbPath);
  instance.exec(SCHEMA_SQL);
  return instance;
}

describe('Cloonex core', () => {
  before(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cloonex-test-'));
    projectRoot = path.join(tmpRoot, 'demo-project');
    fs.mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
    db = freshDb();
  });

  after(() => {
    db.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  test('registers a project idempotently', () => {
    const first = ensureProject(db, { rootPath: projectRoot, name: 'demo' });
    const second = ensureProject(db, { rootPath: projectRoot, name: 'ignored' });
    assert.equal(first.id, second.id);
    assert.equal(first.name, 'demo');
  });

  test('stores project conventions', () => {
    const project = ensureProject(db, { rootPath: projectRoot });
    addConvention(db, project.id, { category: 'layering', content: '业务判断放在 service 层' });
    addConvention(db, project.id, { category: 'stack', content: 'Vue 3 + TypeScript' });
    const conventions = listConventions(db, project.id);
    assert.equal(conventions.length, 2);
  });

  test('feature and refactor tasks allow learning', () => {
    const project = ensureProject(db, { rootPath: projectRoot });
    const featureTask = beginTask(db, {
      projectId: project.id,
      title: '新增订单导出',
      taskType: 'feature',
      intent: '导出当前页订单',
      doneCriteria: '无数据时按钮禁用',
    });
    assert.equal(featureTask.policy.canLearnPreferences, true);
    assert.equal(featureTask.policy.canWriteDecisions, true);
    assert.doesNotThrow(() => assertCanLearnPreferences(featureTask));

    const refactorTask = beginTask(db, { projectId: project.id, title: '重构导出', taskType: 'refactor' });
    assert.equal(refactorTask.policy.canLearnPreferences, true);
  });

  test('bugfix tasks cannot learn preferences or record decisions', () => {
    const project = ensureProject(db, { rootPath: projectRoot });
    const task = beginTask(db, { projectId: project.id, title: '修复导出报错', taskType: 'bugfix' });
    assert.equal(task.policy.canLearnPreferences, false);
    assert.equal(task.policy.canWriteDecisions, false);
    assert.equal(task.policy.canWriteFeatureStatements, false);
    // Reading existing context stays allowed for bugfix work.
    assert.equal(task.policy.canReadContext, true);
    assert.throws(() => assertCanLearnPreferences(task), /不学习个人偏好/);
    assert.throws(() => assertCanWriteDecisions(task), /不记录关键决定/);
  });

  test('unknown task type defaults to no learning', () => {
    const project = ensureProject(db, { rootPath: projectRoot });
    const task = beginTask(db, { projectId: project.id, title: '待定任务', taskType: '随便' });
    assert.equal(task.taskType, 'unknown');
    assert.equal(task.learningState, 'pending');
    assert.equal(task.policy.canLearnPreferences, false);
  });

  test('switching task type recomputes learning state', () => {
    const project = ensureProject(db, { rootPath: projectRoot });
    const task = beginTask(db, { projectId: project.id, title: '先当作修复', taskType: 'bugfix' });
    const updated = updateTask(db, task.id, { taskType: 'feature' });
    assert.equal(updated.learningState, 'enabled');
    assert.equal(updated.policy.canLearnPreferences, true);
  });

  test('decisions keep the reason and its source', () => {
    const project = ensureProject(db, { rootPath: projectRoot });
    const feature = upsertFeature(db, { projectId: project.id, slug: 'order-export', title: '订单导出' });
    const task = beginTask(db, { projectId: project.id, title: '实现导出', taskType: 'feature', featureId: feature.id });
    const decision = addDecision(db, {
      projectId: project.id,
      featureId: feature.id,
      taskId: task.id,
      title: '导出范围',
      choice: '仅导出当前页数据',
      reason: '首期数据量小，先避免增加服务端任务',
      reasonSource: 'user_explicit',
    });
    assert.equal(decision.reasonSource, 'user_explicit');
    assert.equal(decision.status, 'active');
    assert.equal(listDecisions(db, feature.id).length, 1);
  });

  test('a decision without an evidenced reason stays unknown', () => {
    const project = ensureProject(db, { rootPath: projectRoot });
    const feature = upsertFeature(db, { projectId: project.id, slug: 'dark-mode', title: '深色模式' });
    const decision = addDecision(db, {
      projectId: project.id,
      featureId: feature.id,
      title: '配色方案',
      choice: '跟随系统',
      reasonSource: 'unknown',
    });
    assert.equal(decision.reason, null);
    assert.equal(decision.reasonSource, 'unknown');
  });

  test('preference lifecycle: candidate, confirm, revoke', () => {
    const project = ensureProject(db, { rootPath: projectRoot });
    const candidate = addPreference(db, {
      title: '避免多余抽象',
      content: '简单功能不引入多层封装',
      scope: 'project',
      projectId: project.id,
    });
    assert.equal(candidate.status, 'candidate');
    assert.equal(candidate.confirmedAt, null);

    const confirmed = setPreferenceStatus(db, candidate.id, 'confirmed');
    assert.equal(confirmed.status, 'confirmed');
    assert.ok(confirmed.confirmedAt);

    const revoked = revokePreference(db, candidate.id);
    assert.equal(revoked.status, 'revoked');
    // Revoked rules must not be retrievable for new tasks.
    const applicable = queryPreferences(db, { projectId: project.id });
    assert.equal(applicable.some((p) => p.id === candidate.id), false);
  });

  test('candidate preferences are retrievable but not treated as constraints', () => {
    const project = ensureProject(db, { rootPath: projectRoot });
    const candidate = addPreference(db, {
      title: '信息密度优先',
      content: '后台页面减少纯装饰区域',
      scope: 'project',
      projectId: project.id,
    });
    const found = queryPreferences(db, { projectId: project.id });
    assert.ok(found.some((p) => p.id === candidate.id));

    const task = beginTask(db, { projectId: project.id, title: '调整页面', taskType: 'feature' });
    const context = buildTaskContext(db, task);
    const preferenceSection = context.sections.find((s) => s.title === '适用偏好');
    assert.ok(preferenceSection);
    // Unconfirmed candidates are excluded from injected context.
    assert.equal(preferenceSection.items.some((item) => item.includes('信息密度优先')), false);
  });

  test('confirmed preferences are injected into task context', () => {
    const project = ensureProject(db, { rootPath: projectRoot });
    const preference = addPreference(db, {
      title: '统一错误处理',
      content: '错误统一在 service 层转换后再抛出',
      scope: 'project',
      projectId: project.id,
      status: 'confirmed',
    });
    const task = beginTask(db, { projectId: project.id, title: '新增接口', taskType: 'feature' });
    const context = buildTaskContext(db, task);
    const preferenceSection = context.sections.find((s) => s.title === '适用偏好');
    assert.ok(preferenceSection);
    assert.ok(preferenceSection.items.some((item) => item.includes('统一错误处理')));
    assert.ok(preference.id.length > 0);
  });

  test('context respects the character budget and reports omissions', () => {
    const project = ensureProject(db, { rootPath: projectRoot });
    for (let i = 0; i < 40; i += 1) {
      addConvention(db, project.id, { category: 'misc', content: `约定条目 ${i} ${'x'.repeat(80)}` });
    }
    const task = beginTask(db, { projectId: project.id, title: '预算测试', taskType: 'feature' });
    const context = buildTaskContext(db, task, { maxChars: 500 });
    assert.equal(context.budget.exceeded, true);
    assert.ok(context.budget.usedChars <= 500);
    const conventionSection = context.sections.find((s) => s.title === '项目约定');
    assert.ok(conventionSection);
    assert.ok(conventionSection.omitted > 0);
  });

  test('statements can be superseded while keeping history', () => {
    const project = ensureProject(db, { rootPath: projectRoot });
    const feature = upsertFeature(db, { projectId: project.id, slug: 'checkout', title: '结算' });
    const original = addStatement(db, {
      featureId: feature.id,
      section: 'flow',
      content: '提交后跳转支付页',
      reviewState: 'verified',
    });
    const replacement = supersedeStatement(db, {
      statementId: original.id,
      content: '提交后在当前页弹出支付确认',
      reviewState: 'verified',
    });
    assert.equal(replacement.state, 'current');
    const originalRow = db.get('SELECT * FROM feature_statement WHERE id = ?', [original.id]);
    assert.equal(originalRow?.state, 'historical');
    assert.equal(originalRow?.superseded_by, replacement.id);
    assert.equal(originalRow?.review_state, 'stale');
  });

  test('stale detection notices changed files and reports missing ones', () => {
    const project = ensureProject(db, { rootPath: projectRoot });
    const feature = upsertFeature(db, { projectId: project.id, slug: 'export-flow', title: '导出流程' });
    const target = path.join(projectRoot, 'src', 'export.ts');
    fs.writeFileSync(target, 'export const run = () => 1;\n', 'utf8');

    const task = beginTask(db, { projectId: project.id, title: '实现导出', taskType: 'feature', featureId: feature.id });
    finalizeTask(db, {
      task,
      statements: [
        {
          featureId: feature.id,
          section: 'implementation',
          content: '导出逻辑位于 src/export.ts',
          relativePaths: ['src/export.ts'],
        },
      ],
    });

    assert.equal(detectStale(db, project.id).length, 0, 'unchanged file should not be stale');

    fs.writeFileSync(target, 'export const run = () => 2;\n', 'utf8');
    const stale = detectStale(db, project.id);
    assert.equal(stale.length, 1);
    assert.equal(stale[0].section, 'implementation');
    assert.ok(stale[0].evidence.some((e) => e.status === 'changed'));
  });

  test('feature query resolves by slug and by keyword', () => {
    const project = ensureProject(db, { rootPath: projectRoot });
    const feature = upsertFeature(db, { projectId: project.id, slug: 'invoice-list', title: '发票列表' });
    addStatement(db, { featureId: feature.id, section: 'purpose', content: '展示并筛选发票', reviewState: 'verified' });

    const bySlug = resolveFeature(db, project.id, 'invoice-list');
    assert.equal(bySlug?.dossier.feature.slug, 'invoice-list');

    const byKeyword = resolveFeature(db, project.id, '发票');
    assert.equal(byKeyword?.dossier.feature.slug, 'invoice-list');

    const missing = resolveFeature(db, project.id, '不存在的功能xyz');
    assert.equal(missing, null);
  });

  test('feature query separates current statements from history', () => {
    const project = ensureProject(db, { rootPath: projectRoot });
    const feature = upsertFeature(db, { projectId: project.id, slug: 'history-demo', title: '历史演示' });
    const original = addStatement(db, { featureId: feature.id, section: 'rule', content: '旧规则', reviewState: 'verified' });
    supersedeStatement(db, { statementId: original.id, content: '新规则', reviewState: 'verified' });

    const withoutHistory = resolveFeature(db, project.id, 'history-demo', false);
    assert.equal(withoutHistory?.dossier.statements.length, 1);
    assert.equal(withoutHistory?.dossier.history.length, 0);

    const withHistory = resolveFeature(db, project.id, 'history-demo', true);
    assert.equal(withHistory?.dossier.statements.length, 1);
    assert.equal(withHistory?.dossier.history.length, 1);
    assert.equal(withHistory?.dossier.history[0].content, '旧规则');
  });

  test('finalize writes verified statements and captures code state', () => {
    const project = ensureProject(db, { rootPath: projectRoot });
    const feature = upsertFeature(db, { projectId: project.id, slug: 'finalize-demo', title: '结束演示' });
    const file = path.join(projectRoot, 'src', 'finalize-demo.ts');
    fs.writeFileSync(file, 'export const value = 42;\n', 'utf8');

    const task = beginTask(db, { projectId: project.id, title: '实现', taskType: 'feature', featureId: feature.id });
    const result = finalizeTask(db, {
      task,
      outcome: '已完成',
      verification: '本地运行通过',
      statements: [
        { featureId: feature.id, section: 'implementation', content: '值定义在 finalize-demo.ts', relativePaths: ['src/finalize-demo.ts'] },
      ],
    });

    assert.equal(result.statements.length, 1);
    assert.equal(result.statements[0].reviewState, 'verified');
    assert.equal(result.codeState.length, 1);
    assert.ok(result.codeState[0].fingerprint.startsWith('sha256:'));
    const codeState = db.get('SELECT * FROM task_code_state WHERE task_id = ?', [task.id]);
    assert.ok(codeState);
  });

  test('finalize reports a warning instead of silently dropping unreadable evidence', () => {
    const project = ensureProject(db, { rootPath: projectRoot });
    const feature = upsertFeature(db, { projectId: project.id, slug: 'missing-file', title: '缺失文件' });
    const task = beginTask(db, { projectId: project.id, title: '证据缺失', taskType: 'feature', featureId: feature.id });
    const result = finalizeTask(db, {
      task,
      statements: [
        { featureId: feature.id, section: 'implementation', content: '引用不存在的文件', relativePaths: ['src/nope.ts'] },
      ],
    });
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /无法读取文件/);
  });

  test('finalize rejects evidence that escapes the project root', () => {
    const project = ensureProject(db, { rootPath: projectRoot });
    const feature = upsertFeature(db, { projectId: project.id, slug: 'escape', title: '越界' });
    const task = beginTask(db, { projectId: project.id, title: '越界证据', taskType: 'feature', featureId: feature.id });
    const result = finalizeTask(db, {
      task,
      statements: [
        { featureId: feature.id, section: 'implementation', content: '尝试引用外部文件', relativePaths: ['../../outside.ts'] },
      ],
    });
    assert.ok(result.warnings.some((w) => w.includes('越出项目根目录')));
    assert.equal(result.codeState.length, 0);
  });

  test('checkpoints are recorded in order', () => {
    const project = ensureProject(db, { rootPath: projectRoot });
    const task = beginTask(db, { projectId: project.id, title: '长任务', taskType: 'feature' });
    saveCheckpoint(db, task.id, { summary: '第一步完成', remaining: '还需要处理错误分支' });
    saveCheckpoint(db, task.id, { summary: '第二步完成' });
    const checkpoints = db.all('SELECT * FROM checkpoint WHERE task_id = ? ORDER BY created_at', [task.id]);
    assert.equal(checkpoints.length, 2);
    assert.equal(checkpoints[0].summary, '第一步完成');
  });

  test('markdown export contains the task intent and policy note', () => {
    const project = ensureProject(db, { rootPath: projectRoot });
    const task = beginTask(db, {
      projectId: project.id,
      title: '交接演示',
      taskType: 'feature',
      intent: '导出筛选结果',
      doneCriteria: '勾选无数据时禁用',
    });
    const markdown = exportTaskMarkdown(db, task);
    assert.match(markdown, /# 交接演示/);
    assert.match(markdown, /导出筛选结果/);
    assert.match(markdown, /学习状态/);
    assert.match(markdown, /新功能开发/);
  });

  test('revoking a preference keeps it out of new task context', () => {
    const project = ensureProject(db, { rootPath: projectRoot });
    const preference = addPreference(db, {
      title: '临时禁用规则',
      content: '不应出现在新任务中',
      scope: 'project',
      projectId: project.id,
      status: 'confirmed',
    });
    revokePreference(db, preference.id);
    const task = beginTask(db, { projectId: project.id, title: '撤销后任务', taskType: 'feature' });
    const context = buildTaskContext(db, task);
    const section = context.sections.find((s) => s.title === '适用偏好');
    assert.ok(section);
    assert.equal(section.items.some((item) => item.includes('临时禁用规则')), false);
  });

  test('listing features and preferences excludes retired entries by default', () => {
    const project = ensureProject(db, { rootPath: projectRoot });
    const feature = upsertFeature(db, { projectId: project.id, slug: 'retire-me', title: '待退役' });
    db.run("UPDATE feature SET status = 'archived' WHERE id = ?", [feature.id]);
    assert.equal(listFeatures(db, project.id).some((f) => f.id === feature.id), false);

    const preference = addPreference(db, { title: '待撤销', content: 'x', scope: 'global', status: 'revoked' });
    assert.equal(listPreferences(db).some((p) => p.id === preference.id), false);
    assert.equal(listPreferences(db, true).some((p) => p.id === preference.id), true);
    assert.ok(getFeature(db, feature.id));
  });
});
