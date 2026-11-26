import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { gunzipSync, gzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { openDb } from '../src/db/storage.js';
import { exportBackup, importBackup, inspectBackup } from '../src/db/backup.js';
import { ensureProject, importProjectRules, moveProject, addProjectGroup } from '../src/domain/project.js';
import { ensureFeature, getFeature, getStatement, upsertFeature, supersedeStatement, addDecision, supersedeDecision } from '../src/domain/feature.js';
import { beginTask, getTask } from '../src/domain/task.js';
import { finalizeTask, reviewStatement } from '../src/domain/finalize.js';
import { detectStale, buildTaskContext } from '../src/domain/context.js';
import { featureDossier } from '../src/domain/feature-query.js';
import { searchRecords } from '../src/domain/search.js';
import { projectHealth } from '../src/domain/health.js';
import { setLabelAlias } from '../src/domain/labels.js';
import { addPreference, queryPreferences } from '../src/domain/preference.js';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cloonex-v020-'));
  const data = path.join(root, 'data');
  const projectRoot = path.join(root, 'project');
  fs.mkdirSync(projectRoot);
  fs.writeFileSync(path.join(projectRoot, 'a.ts'), 'export const a=1;\n');
  const db = openDb({ dataDir: data });
  const project = ensureProject(db, { rootPath: projectRoot });
  const feature = upsertFeature(db, { projectId: project.id, slug: 'export', title: '订单导出' });
  return { root, data, projectRoot, db, project, feature, close() { db.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

test('freshness is checked on reads; review refreshes baselines and preserves history', () => {
  const f = fixture();
  try {
    ensureFeature(f.db, f.project.id, 'export');
    assert.equal(getFeature(f.db, f.feature.id)?.title, '订单导出');
    const task = beginTask(f.db, { projectId: f.project.id, title: 'Add export', taskType: 'feature' });
    const saved = finalizeTask(f.db, { task, statements: [{ featureId: f.feature.id, section: 'implementation', content: 'Export loaded IDs', topicKey: 'serializer', relativePaths: ['a.ts'] }] });
    assert.equal(getTask(f.db, task.id)?.status, 'done');
    assert.equal(getTask(f.db, task.id)?.featureId, f.feature.id);
    const oldFingerprint = saved.statements[0].evidence[0].fingerprint;
    fs.appendFileSync(path.join(f.projectRoot, 'a.ts'), '// edit\n');
    const dossier = featureDossier(f.db, f.feature.id)!;
    assert.equal(dossier.statements[0].recordedReviewState, 'verified');
    assert.equal(dossier.statements[0].reviewState, 'stale');
    assert.equal(dossier.statements[0].freshness.status, 'changed');
    assert.ok(buildTaskContext(f.db, getTask(f.db, task.id)!).warnings.some((w) => w.includes('过时')));
    reviewStatement(f.db, saved.statements[0].id, 'verified');
    assert.equal(detectStale(f.db, f.project.id).length, 0);
    assert.notEqual(getStatement(f.db, saved.statements[0].id)?.evidence[0].fingerprint, oldFingerprint);
    assert.equal(f.db.all('SELECT * FROM statement_review').length, 1);
    assert.ok(String(f.db.get('SELECT evidence_json FROM statement_review')?.evidence_json).includes(String(oldFingerprint)));
    fs.appendFileSync(path.join(f.projectRoot, 'a.ts'), '// another edit\n');
    const next = beginTask(f.db, { projectId: f.project.id, title: 'Recheck', taskType: 'refactor' });
    const refreshed = finalizeTask(f.db, { task: next, statements: [{ featureId: f.feature.id, section: 'implementation', content: 'Export loaded IDs', relativePaths: ['a.ts'] }] });
    assert.equal(refreshed.refreshed, 1);
    assert.equal(refreshed.codeState.length, 1);
    assert.equal(f.db.all('SELECT * FROM feature_statement').length, 1);
    assert.equal(detectStale(f.db, f.project.id).length, 0);
    assert.throws(() => finalizeTask(f.db, { task: next }), /重复结束/);
  } finally { f.close(); }
});

test('finalize links multiple features atomically and rolls back on invalid topics', () => {
  const f = fixture();
  try {
    const second = upsertFeature(f.db, { projectId: f.project.id, title: 'Second feature' });
    const task = beginTask(f.db, { projectId: f.project.id, title: 'Multi', taskType: 'feature' });
    finalizeTask(f.db, { task, statements: [f.feature, second].map((feature) => ({ featureId: feature.id, section: 'rule', content: feature.title, topicKey: 'rule' })) });
    assert.equal(getTask(f.db, task.id)?.featureIds.length, 2);
    assert.ok(buildTaskContext(f.db, getTask(f.db, task.id)!).sections.find((s) => s.title === '关联功能')?.items.some((i) => i.includes('Second feature')));
    const invalid = beginTask(f.db, { projectId: f.project.id, title: 'Fail', taskType: 'feature' });
    assert.throws(() => finalizeTask(f.db, { task: invalid, statements: [
      { featureId: second.id, section: 'rule', content: 'temporary insert' },
      { featureId: f.feature.id, section: 'rule', content: 'conflicting topic', topicKey: 'rule' },
    ] }), /显式替代/);
    assert.equal(getTask(f.db, invalid.id)?.status, 'open');
    assert.equal(getTask(f.db, invalid.id)?.featureIds.length, 0);
    assert.equal(f.db.get("SELECT id FROM feature_statement WHERE content='temporary insert'"), undefined);
  } finally { f.close(); }
});

test('explicit replacement preserves old statements and decisions', () => {
  const f = fixture();
  try {
    const task = beginTask(f.db, { projectId: f.project.id, title: 'Versioned', taskType: 'feature' });
    const saved = finalizeTask(f.db, { task, statements: [{ featureId: f.feature.id, section: 'rule', content: 'old', topicKey: 'scope', relativePaths: ['a.ts'] }] });
    const next = supersedeStatement(f.db, { statementId: saved.statements[0].id, content: 'new', note: 'Explicit new requirement' });
    assert.equal(next.topicKey, 'scope');
    assert.equal(getStatement(f.db, saved.statements[0].id)?.state, 'historical');
    assert.equal(featureDossier(f.db, f.feature.id, true)?.history.length, 1);
    assert.throws(() => supersedeStatement(f.db, { statementId: saved.statements[0].id, content: 'again' }), /当前说明/);
    const decision = addDecision(f.db, { projectId: f.project.id, featureId: f.feature.id, title: 'Scope', choice: 'one', reasonSource: 'unknown' });
    supersedeDecision(f.db, decision.id, { projectId: f.project.id, title: 'Scope', choice: 'two', reasonSource: 'unknown' });
    assert.equal(f.db.get('SELECT status FROM decision WHERE id=?', [decision.id])?.status, 'superseded');
  } finally { f.close(); }
});

test('backup restores all record types, exports and evidence into a new computer directory', () => {
  const f = fixture();
  try {
    const task = beginTask(f.db, { projectId: f.project.id, title: '历史任务', taskType: 'feature' });
    const saved = finalizeTask(f.db, { task, statements: [{ featureId: f.feature.id, section: 'rule', content: '历史说明', relativePaths: ['a.ts'] }] });
    reviewStatement(f.db, saved.statements[0].id, 'verified');
    addDecision(f.db, { projectId: f.project.id, featureId: f.feature.id, taskId: task.id, title: '决定', choice: '保留', reasonSource: 'unknown' });
    addPreference(f.db, { title: '偏好', content: '真实规则', scope: 'project', projectId: f.project.id, status: 'confirmed' });
    addProjectGroup(f.db, 'suite', [f.project.id]);
    setLabelAlias(f.db, 'stack', 'vue2-uniapp', 'uni-app-vue2');
    fs.mkdirSync(path.join(f.data, 'exports/资料'), { recursive: true });
    fs.writeFileSync(path.join(f.data, 'exports/资料/交接.md'), '# 历史交接\n');
    const archive = path.join(f.root, 'history.cloonex.gz');
    const exported = exportBackup(f.data, archive);
    assert.equal(exported.counts.task, 1);
    assert.equal(inspectBackup(archive).schemaVersion, 3);
    const destination = path.join(f.root, 'new-computer');
    importBackup(archive, destination);
    const restored = openDb({ dataDir: destination });
    try {
      assert.equal(getTask(restored, task.id)?.featureId, f.feature.id);
      assert.equal(restored.all('SELECT * FROM decision').length, 1);
      assert.equal(restored.all('SELECT * FROM statement_review').length, 1);
      assert.equal(restored.all('SELECT * FROM project_group').length, 1);
      assert.equal(restored.all('SELECT * FROM label_alias').length, 1);
      assert.equal(fs.readFileSync(path.join(destination, 'exports/资料/交接.md'), 'utf8'), '# 历史交接\n');
      const relocated = path.join(f.root, 'new-code');
      fs.cpSync(f.projectRoot, relocated, { recursive: true });
      moveProject(restored, f.project.id, relocated);
      assert.equal(projectHealth(restored, f.project.id, true).projects[0].freshness?.unchanged, 1);
    } finally { restored.close(); }
    assert.throws(() => importBackup(archive, destination), /不会覆盖/);
    assert.throws(() => exportBackup(f.data, archive), /已存在/);
  } finally { f.close(); }
});

test('corrupt, malicious and incomplete archives cannot change the destination', () => {
  const f = fixture();
  try {
    const archive = path.join(f.root, 'valid.gz');
    exportBackup(f.data, archive);
    const original = JSON.parse(gunzipSync(fs.readFileSync(archive)).toString());
    const broken = path.join(f.root, 'bad.gz');
    const target = path.join(f.root, 'destination');
    fs.writeFileSync(broken, 'not gzip');
    assert.throws(() => importBackup(broken, target));
    assert.equal(fs.existsSync(target), false);
    const modified = structuredClone(original);
    modified.database.sha256 = '0'.repeat(64);
    fs.writeFileSync(broken, gzipSync(JSON.stringify(modified)));
    assert.throws(() => importBackup(broken, target), /校验失败/);
    modified.database = original.database;
    modified.files = [{ path: 'exports/../../escape', sha256: '0'.repeat(64), base64: '' }];
    fs.writeFileSync(broken, gzipSync(JSON.stringify(modified)));
    assert.throws(() => importBackup(broken, target), /不安全/);
    assert.equal(fs.existsSync(target), false);
    modified.files = [];
    modified.counts.project += 1;
    fs.writeFileSync(broken, gzipSync(JSON.stringify(modified)));
    assert.throws(() => importBackup(broken, target), /清单与数据库/);
    assert.equal(fs.existsSync(target), false);
    modified.counts = original.counts;
    modified.schemaVersion = 99;
    fs.writeFileSync(broken, gzipSync(JSON.stringify(modified)));
    assert.throws(() => importBackup(broken, target));
  } finally { f.close(); }
});

test('rules preview is read-only, changed rules stop applying, aliases stay scoped and searches explain matches', () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.projectRoot, 'AGENTS.md'), '业务时间统一到秒。');
    importProjectRules(f.db, f.project.id);
    assert.equal(f.db.all('SELECT * FROM project_convention').length, 0);
    importProjectRules(f.db, f.project.id, 'AGENTS.md', true);
    const task = beginTask(f.db, { projectId: f.project.id, title: '订单导出', taskType: 'feature' });
    assert.ok(buildTaskContext(f.db, task).sections[0].items.some((i) => i.includes('统一到秒')));
    fs.appendFileSync(path.join(f.projectRoot, 'AGENTS.md'), '\n规范更新。');
    const context = buildTaskContext(f.db, task);
    assert.equal(context.sections[0].items.length, 0);
    assert.ok(context.warnings.some((w) => w.includes('规则来源')));
    addPreference(f.db, { title: '样式', content: '复用', scope: 'stack', stack: 'uni-app-vue2', projectId: f.project.id, status: 'confirmed' });
    setLabelAlias(f.db, 'stack', 'vue2-uniapp', 'uni-app-vue2');
    assert.equal(queryPreferences(f.db, { projectId: f.project.id, stack: 'vue2-uniapp' }).length, 1);
    assert.equal(queryPreferences(f.db, { projectId: f.project.id, stack: '["typescript","vue2-uniapp"]' }).length, 1);
    assert.equal(queryPreferences(f.db, { projectId: 'another', stack: 'vue2-uniapp' }).length, 0);
    assert.throws(() => setLabelAlias(f.db, 'stack', 'uni-app-vue2', 'vue2-uniapp'), /循环/);
    const result = searchRecords(f.db, '订单导出', { projectId: f.project.id });
    assert.ok(result.some((r) => r.type === 'task' && r.matchedFields.includes('title')));
    assert.ok(result.some((r) => r.type === 'feature'));
    assert.equal(searchRecords(f.db, '订单导出', { projectId: 'another' }).length, 0);
  } finally { f.close(); }
});

test('installed CLI migration commands work before init and never overwrite existing history', () => {
  const f = fixture();
  try {
    const cli = path.resolve('dist/src/cli.js');
    const config = path.join(f.root, 'client/config.json');
    const env = { ...process.env, CLOONEX_CONFIG: config, CLOONEX_DATA_DIR: f.data };
    const run = (...args: string[]) => execFileSync(process.execPath, [cli, ...args], { env, encoding: 'utf8', stdio: 'pipe' });
    const archive = path.join(f.root, '电脑迁移.cloonex.gz');
    assert.equal(run('--version').trim(), '0.2.0');
    assert.ok(JSON.parse(run('mcp-config', '--format', 'json')).mcpServers.cloonex.command);
    run('backup', 'export', '--out', archive);
    const inspected = JSON.parse(run('backup', 'inspect', archive));
    assert.equal(inspected.counts.project, 1);
    const target = path.join(f.root, '另一台电脑');
    run('backup', 'import', archive, '--data-dir', target);
    assert.equal(JSON.parse(fs.readFileSync(config, 'utf8')).dataDir, target);
    const before = fs.readFileSync(path.join(target, 'cloonex.sqlite'));
    assert.throws(() => run('backup', 'import', archive, '--data-dir', target));
    assert.deepEqual(fs.readFileSync(path.join(target, 'cloonex.sqlite')), before);
    const diagnostic = JSON.parse(run('doctor', '--data-dir', target));
    assert.equal(diagnostic.projects.length, 1);
    assert.equal(diagnostic.integrity, 'ok');
  } finally { f.close(); }
});
