import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, describe, before, after } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

/**
 * Protocol-level test: spawns the real MCP server over stdio exactly as Codex
 * does. This is the "接入原型" risk the product doc flags in §13.1, so it is
 * verified against the real transport rather than by importing handlers.
 */
let tmpRoot: string;
let dataDir: string;
let projectRoot: string;
let client: Client;
let transport: StdioClientTransport;

function parse(result: unknown): any {
  const content = (result as { content: Array<{ type: string; text: string }> }).content;
  return JSON.parse(content[0].text);
}

async function call(name: string, args: Record<string, unknown>): Promise<any> {
  const result = await client.callTool({ name, arguments: args });
  return parse(result);
}

describe('Cloonex MCP server', () => {
  before(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cloonex-mcp-'));
    dataDir = path.join(tmpRoot, 'data');
    projectRoot = path.join(tmpRoot, 'app');
    fs.mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'src', 'export.ts'), 'export const run = () => 1;\n', 'utf8');

    transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.resolve('dist/src/mcp/server.js')],
      env: { ...process.env, CLOONEX_DATA_DIR: dataDir },
      stderr: 'pipe',
    });
    client = new Client({ name: 'cloonex-test', version: '0.0.0' }, { capabilities: {} });
    await client.connect(transport);
  });

  after(async () => {
    await client.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  test('server advertises the expected tools', async () => {
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    for (const expected of [
      'project_init',
      'begin_task',
      'get_context',
      'record_decision',
      'save_checkpoint',
      'finalize_task',
      'query_feature',
      'propose_preference',
      'manage_preference',
      'stale_check',
      'export_context',
      'data_info',
    ]) {
      assert.ok(names.includes(expected), `missing tool: ${expected}`);
    }
  });

  test('full closed loop: init, task, context, decision, finalize, query', async () => {
    const init = await call('project_init', { rootPath: projectRoot, name: '演示项目' });
    assert.equal(init.project.name, '演示项目');

    const convention = await call('project_add_convention', {
      projectRoot,
      category: 'layering',
      content: 'API 调用统一封装在 services 目录',
      source: '现有代码',
    });
    assert.ok(convention.conventionId);

    const begun = await call('begin_task', {
      projectRoot,
      title: '新增订单导出',
      taskType: 'feature',
      featureSlug: 'order-export',
      intent: '导出当前页订单',
      doneCriteria: '无数据时导出按钮禁用',
    });
    assert.equal(begun.task.policy.canLearnPreferences, true);
    const taskId = begun.task.id as string;

    const context = await call('get_context', { taskId });
    assert.equal(context.project.name, '演示项目');
    const conventions = context.sections.find((s: { title: string }) => s.title === '项目约定');
    assert.ok(conventions.items.some((i: string) => i.includes('services 目录')));

    const decision = await call('record_decision', {
      taskId,
      title: '导出数据范围',
      choice: '仅导出当前页已有数据',
      reason: '首期数据量小，先避免增加服务端任务',
      reasonSource: 'user_explicit',
      featureSlug: 'order-export',
    });
    assert.equal(decision.decision.reasonSource, 'user_explicit');

    const checkpoint = await call('save_checkpoint', { taskId, summary: '功能已实现，待验证空数据状态' });
    assert.ok(checkpoint.checkpointId);

    const finalized = await call('finalize_task', {
      taskId,
      outcome: '导出功能已完成',
      verification: '已手动验证有数据与无数据两种情况',
      feature: { slug: 'order-export', title: '订单导出', purpose: '导出当前页订单数据' },
      statements: [
        {
          featureSlug: 'order-export',
          section: 'implementation',
          content: '导出逻辑位于 src/export.ts',
          relativePaths: ['src/export.ts'],
        },
      ],
    });
    assert.equal(finalized.task.status, 'done');
    assert.equal(finalized.result.statements.length, 1);

    const queried = await call('query_feature', { projectRoot, query: '订单导出', includeHistory: true });
    assert.equal(queried.found, true);
    assert.equal(queried.dossier.feature.slug, 'order-export');
    assert.ok(queried.dossier.decisions.some((d: { title: string }) => d.title === '导出数据范围'));
    assert.ok(queried.dossier.statements.some((s: { content: string }) => s.content.includes('src/export.ts')));
  });

  test('bugfix task cannot record decisions or learn preferences', async () => {
    const begun = await call('begin_task', {
      projectRoot,
      title: '修复导出报错',
      taskType: 'bugfix',
      featureSlug: 'order-export',
    });
    assert.equal(begun.task.policy.canLearnPreferences, false);
    const taskId = begun.task.id as string;

    const decision = await call('record_decision', {
      taskId,
      title: '临时修复',
      choice: '加空值判断',
      reasonSource: 'unknown',
    });
    assert.equal(decision.error !== undefined, true);
    assert.match(String(decision.error), /不记录关键决定/);

    const preference = await call('propose_preference', {
      taskId,
      title: '空值判断',
      content: '导出前总是判断空值',
    });
    assert.equal(preference.error !== undefined, true);
    assert.match(String(preference.error), /不学习个人偏好/);
  });

  test('bugfix task can still read existing context', async () => {
    const begun = await call('begin_task', { projectRoot, title: '修复筛选', taskType: 'bugfix' });
    const context = await call('get_context', { taskId: begun.task.id });
    assert.equal(context.policyRationale.includes('Bug 修复'), true);
    const conventions = context.sections.find((s: { title: string }) => s.title === '项目约定');
    assert.ok(conventions.items.length > 0, 'bugfix work still receives project conventions');
  });

  test('preference candidate flow and confirmation', async () => {
    const begun = await call('begin_task', {
      projectRoot,
      title: '新增列表页',
      taskType: 'feature',
      featureSlug: 'list-page',
    });
    const taskId = begun.task.id as string;

    const candidate = await call('propose_preference', {
      taskId,
      title: '信息密度优先',
      content: '后台页面减少纯装饰区域',
      scope: 'project',
    });
    assert.equal(candidate.preference.status, 'candidate');

    const confirmed = await call('manage_preference', {
      action: 'confirm',
      preferenceId: candidate.preference.id,
    });
    assert.equal(confirmed.preference.status, 'confirmed');

    const listed = await call('manage_preference', { action: 'list' });
    assert.ok(listed.preferences.some((p: { id: string }) => p.id === candidate.preference.id));

    const revoke = await call('manage_preference', {
      action: 'revoke',
      preferenceId: candidate.preference.id,
    });
    assert.equal(revoke.preference.status, 'revoked');
  });

  test('stale_check reports changed code after finalisation', async () => {
    const target = path.join(projectRoot, 'src', 'export.ts');
    fs.writeFileSync(target, 'export const run = () => 2;\n', 'utf8');
    const report = await call('stale_check', { projectRoot });
    assert.ok(report.staleCount >= 1);
    assert.ok(report.reports.some((r: { section: string }) => r.section === 'implementation'));
  });

  test('export_context writes a handover markdown file', async () => {
    const tasks = await call('list_tasks', { projectRoot, limit: 10 });
    const done = tasks.tasks.find((t: { status: string }) => t.status === 'done');
    assert.ok(done);
    const outFile = path.join(tmpRoot, 'handover.md');
    const exported = await call('export_context', { taskId: done.id, outFile });
    assert.equal(exported.file, outFile);
    const markdown = fs.readFileSync(outFile, 'utf8');
    assert.match(markdown, /订单导出/);
  });

  test('data_info reports the configured data directory', async () => {
    const info = await call('data_info', { detail: true });
    assert.equal(info.dataDir, dataDir);
    assert.ok(info.counts.projects >= 1);
    assert.ok(info.counts.decisions >= 1);
  });
});
