import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, describe, before, after } from 'node:test';
import { Db } from '../src/db/database.js';
import { SCHEMA_SQL } from '../src/db/schema.js';
import { ensureProject } from '../src/domain/project.js';
import { beginTask, updateTask } from '../src/domain/task.js';
import { upsertFeature } from '../src/domain/feature.js';
import { finalizeTask } from '../src/domain/finalize.js';

/**
 * Repeat / interruption behaviour (product doc §13.2: "中断或重复执行不产生
 * 相互矛盾的重复完成记录"). These tests pin the guarantee down.
 */
let tmpRoot: string;
let projectRoot: string;
let db: Db;

function freshDb(): Db {
  const instance = new Db(path.join(tmpRoot, `idem-${Math.random().toString(36).slice(2)}.sqlite`));
  instance.exec(SCHEMA_SQL);
  return instance;
}

describe('finalize repeat safety', () => {
  before(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cloonex-idem-'));
    projectRoot = path.join(tmpRoot, 'app');
    fs.mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'src', 'a.ts'), 'export const a = 1;\n', 'utf8');
    db = freshDb();
  });

  after(() => {
    db.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  test('finalising an already-completed task is refused', () => {
    const project = ensureProject(db, { rootPath: projectRoot });
    const feature = upsertFeature(db, { projectId: project.id, slug: 'repeat', title: '重复提交' });
    const task = beginTask(db, { projectId: project.id, title: '重复结束', taskType: 'feature', featureId: feature.id });

    finalizeTask(db, {
      task,
      statements: [{ featureId: feature.id, section: 'implementation', content: '第一次说明', relativePaths: ['src/a.ts'] }],
    });
    const completed = updateTask(db, task.id, { status: 'done' });

    assert.throws(
      () =>
        finalizeTask(db, {
          task: completed,
          statements: [{ featureId: feature.id, section: 'implementation', content: '第二次说明' }],
        }),
      /重复结束会产生矛盾记录/,
    );
  });

  test('identical statement content is skipped rather than duplicated', () => {
    const project = ensureProject(db, { rootPath: projectRoot });
    const feature = upsertFeature(db, { projectId: project.id, slug: 'dedupe', title: '去重' });
    const taskA = beginTask(db, { projectId: project.id, title: 'A', taskType: 'feature', featureId: feature.id });
    const taskB = beginTask(db, { projectId: project.id, title: 'B', taskType: 'feature', featureId: feature.id });

    const first = finalizeTask(db, {
      task: taskA,
      statements: [{ featureId: feature.id, section: 'implementation', content: '相同说明', relativePaths: ['src/a.ts'] }],
    });
    const second = finalizeTask(db, {
      task: taskB,
      statements: [{ featureId: feature.id, section: 'implementation', content: '相同说明', relativePaths: ['src/a.ts'] }],
    });

    assert.equal(first.statements.length, 1);
    assert.equal(first.skipped, 0);
    assert.equal(second.statements.length, 0);
    assert.equal(second.skipped, 1, 'duplicate content must be reported as skipped');

    const rows = db.all(
      "SELECT * FROM feature_statement WHERE feature_id = ? AND state = 'current' AND content = '相同说明'",
      [feature.id],
    );
    assert.equal(rows.length, 1, 'only one current statement must exist');
  });

  test('an abandoned task cannot be finalised', () => {
    const project = ensureProject(db, { rootPath: projectRoot });
    const task = beginTask(db, { projectId: project.id, title: '放弃的任务', taskType: 'feature' });
    const abandoned = updateTask(db, task.id, { status: 'abandoned' });
    assert.throws(() => finalizeTask(db, { task: abandoned }), /已放弃/);
  });
});
