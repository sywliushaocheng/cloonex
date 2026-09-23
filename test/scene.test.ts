import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, describe, before, after } from 'node:test';
import { Db } from '../src/db/database.js';
import { SCHEMA_SQL } from '../src/db/schema.js';
import { ensureProject } from '../src/domain/project.js';
import { beginTask, updateTask } from '../src/domain/task.js';
import { addPreference, queryPreferences } from '../src/domain/preference.js';
import { buildTaskContext } from '../src/domain/context.js';

/**
 * Scene/stack scoping is how UI rules stay applicable: a rule recorded for
 * "后台管理页" must not be applied to a brand marketing page. These tests pin
 * that boundary, because misapplying a styling rule is exactly the failure the
 * product exists to prevent.
 */
let tmpRoot: string;
let projectRoot: string;
let db: Db;

function freshDb(name: string): Db {
  const instance = new Db(path.join(tmpRoot, `${name}.sqlite`));
  instance.exec(SCHEMA_SQL);
  return instance;
}

describe('scene and stack scoped preferences', () => {
  before(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cloonex-scene-'));
    projectRoot = path.join(tmpRoot, 'app');
    fs.mkdirSync(projectRoot, { recursive: true });
    db = freshDb('scene');
  });

  after(() => {
    db.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  test('a scene rule is returned only for its own scene', () => {
    const project = ensureProject(db, { rootPath: projectRoot });
    addPreference(db, {
      title: '后台页信息密度优先',
      content: '减少纯装饰区域，操作按钮靠近对应内容',
      scope: 'scene',
      scene: 'admin-page',
      projectId: project.id,
      status: 'confirmed',
    });

    assert.equal(
      queryPreferences(db, { projectId: project.id, scene: 'admin-page' }).length,
      1,
      'matching scene must return the rule',
    );
    assert.equal(
      queryPreferences(db, { projectId: project.id, scene: 'marketing-page' }).length,
      0,
      'a different scene must NOT inherit an admin-page rule',
    );
    assert.equal(
      queryPreferences(db, { projectId: project.id }).length,
      0,
      'without a scene, a scene rule must not be applied',
    );
  });

  test('a stack rule is returned only for its own stack', () => {
    const project = ensureProject(db, { rootPath: projectRoot });
    addPreference(db, {
      title: 'script setup 写法',
      content: 'Vue 组件统一使用 script setup',
      scope: 'stack',
      stack: 'vue3',
      projectId: project.id,
      status: 'confirmed',
    });

    assert.equal(queryPreferences(db, { projectId: project.id, stack: 'vue3' }).length, 1);
    assert.equal(queryPreferences(db, { projectId: project.id, stack: 'react' }).length, 0);
  });

  test('a project rule still applies to the whole project', () => {
    const project = ensureProject(db, { rootPath: projectRoot });
    addPreference(db, {
      title: '项目级约定',
      content: '所有页面共用现有组件库',
      scope: 'project',
      projectId: project.id,
      status: 'confirmed',
    });

    const found = queryPreferences(db, { projectId: project.id, scene: 'whatever' });
    assert.ok(
      found.some((p) => p.title === '项目级约定'),
      'project-scoped rules must apply regardless of scene',
    );
  });

  test('task context loads a matching scene rule', () => {
    const project = ensureProject(db, { rootPath: projectRoot });
    addPreference(db, {
      title: '后台页按钮位置',
      content: '操作按钮紧邻对应内容',
      scope: 'scene',
      scene: 'admin-page',
      projectId: project.id,
      status: 'confirmed',
    });

    const task = beginTask(db, {
      projectId: project.id,
      title: '优化后台页样式',
      taskType: 'refactor',
      scene: 'admin-page',
    });
    const context = buildTaskContext(db, task);
    const section = context.sections.find((s) => s.title === '适用偏好');
    assert.ok(section);
    assert.ok(
      section.items.some((item) => item.includes('后台页按钮位置')),
      'a matching scene rule must reach the task context',
    );
    // The scope target is shown so the model can see why the rule applies.
    assert.ok(section.items.some((item) => item.includes('scene:admin-page')));
  });

  test('task context excludes a rule for a different scene', () => {
    const project = ensureProject(db, { rootPath: projectRoot });
    const task = beginTask(db, {
      projectId: project.id,
      title: '优化品牌首页样式',
      taskType: 'refactor',
      scene: 'marketing-page',
    });
    const context = buildTaskContext(db, task);
    const section = context.sections.find((s) => s.title === '适用偏好');
    assert.ok(section);
    assert.equal(
      section.items.some((item) => item.includes('后台页按钮位置')),
      false,
      'admin-page rules must not leak into a marketing page task',
    );
  });

  test('unresolved scene rules are reported instead of silently dropped', () => {
    const project = ensureProject(db, { rootPath: projectRoot });
    const task = beginTask(db, {
      projectId: project.id,
      title: '未指定场景的样式调整',
      taskType: 'refactor',
    });
    const context = buildTaskContext(db, task);
    assert.ok(
      context.warnings.some((w) => w.includes('按场景限定')),
      '必须提示存在因未指定场景而未加载的规则',
    );
  });

  test('scene can be set after the task begins', () => {
    const project = ensureProject(db, { rootPath: projectRoot });
    const task = beginTask(db, { projectId: project.id, title: '稍后补场景', taskType: 'refactor' });
    const before = buildTaskContext(db, task);
    assert.equal(
      before.sections.find((s) => s.title === '适用偏好')?.items.some((i) => i.includes('后台页按钮位置')),
      false,
    );

    const updated = updateTask(db, task.id, { scene: 'admin-page' });
    const after = buildTaskContext(db, updated);
    assert.ok(
      after.sections.find((s) => s.title === '适用偏好')?.items.some((i) => i.includes('后台页按钮位置')),
      '设置场景后，该场景的规则应当出现',
    );
  });
});

describe('schema migration for existing databases', () => {
  let migRoot: string;

  before(() => {
    migRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cloonex-migrate-'));
  });

  after(() => {
    fs.rmSync(migRoot, { recursive: true, force: true });
  });

  test('an old database without stack/scene is upgraded in place, keeping data', async () => {
    const dbFile = path.join(migRoot, 'cloonex.sqlite');

    // Build a database shaped like the previous version: task lacks stack/scene.
    const legacy = new Db(dbFile);
    legacy.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE project (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, root_path TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE task (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
        feature_id TEXT,
        title TEXT NOT NULL,
        task_type TEXT NOT NULL,
        learning_state TEXT NOT NULL,
        intent TEXT, in_scope TEXT, out_of_scope TEXT, constraints TEXT, done_criteria TEXT,
        status TEXT NOT NULL, outcome TEXT, verification TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, closed_at TEXT
      );
    `);
    const now = new Date().toISOString();
    legacy.run('INSERT INTO project VALUES (?, ?, ?, ?, ?)', ['prj_old', '旧项目', 'D:/old', now, now]);
    legacy.run(
      `INSERT INTO task (id, project_id, title, task_type, learning_state, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['task_old', 'prj_old', '历史任务', 'feature', 'enabled', 'done', now, now],
    );
    legacy.close();

    // Reopening through openDb must add the columns without losing the row.
    const { openDb } = await import('../src/db/storage.js');
    const upgraded = openDb({ dataDir: migRoot });
    try {
      const columns = upgraded.all('PRAGMA table_info(task)').map((r) => String(r.name));
      assert.ok(columns.includes('stack'), '升级后应有 stack 列');
      assert.ok(columns.includes('scene'), '升级后应有 scene 列');

      const row = upgraded.get('SELECT * FROM task WHERE id = ?', ['task_old']);
      assert.ok(row, '既有任务必须保留');
      assert.equal(row?.title, '历史任务');
      assert.equal(row?.status, 'done');
    } finally {
      upgraded.close();
    }
  });
});
