#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import fs from 'node:fs';
import path from 'node:path';
import { Db } from '../db/database.js';
import { dataDirSize, formatBytes, openDb, resolvePaths } from '../db/storage.js';
import { nowIso } from '../db/util.js';
import {
  addConvention,
  ensureProject,
  findProjectByPath,
  listConventions,
  listProjects,
} from '../domain/project.js';
import {
  assertCanLearnPreferences,
  assertCanWriteDecisions,
  assertCanWriteFeatureStatements,
  beginTask,
  findOpenTasks,
  getTask,
  listCheckpoints,
  listTasks,
  saveCheckpoint,
  updateTask,
} from '../domain/task.js';
import { addDecision, listFeatures, upsertFeature } from '../domain/feature.js';
import { addPreference, listPreferences, revokePreference, setPreferenceStatus, supersedePreference } from '../domain/preference.js';
import { buildTaskContext, detectStale } from '../domain/context.js';
import { finalizeTask, reviewStatement } from '../domain/finalize.js';
import { resolveFeature } from '../domain/feature-query.js';
import { exportTaskMarkdown } from '../export/markdown.js';
import * as S from './schemas.js';

/**
 * Cloonex MCP server (product doc §11.2).
 *
 * Runs over stdio so Codex starts it on demand: no port, no daemon, no
 * background service. Handlers answer with JSON rather than prose, and every
 * write passes through the learning-policy guards in domain/task.ts.
 */
const db: Db = openDb();
const paths = resolvePaths();

function json(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

function failure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return { isError: true as const, content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }] };
}

function resolveProjectRef(rootPath: string) {
  return findProjectByPath(db, rootPath) ?? ensureProject(db, { rootPath });
}

function requireTask(taskId: string) {
  const task = getTask(db, taskId);
  if (!task) throw new Error(`未找到任务：${taskId}`);
  return task;
}

function requireFeature(projectId: string, slug: string) {
  return upsertFeature(db, { projectId, slug, title: slug });
}

const server = new McpServer(
  { name: 'cloonex', version: '0.1.0' },
  {
    instructions: [
      'Cloonex 保存用户的开发意图、项目约定、关键决定与功能档案，使其独立于具体模型。',
      '标准流程：新功能或重构任务先 begin_task → 开发前 get_context → 过程中 save_checkpoint / record_decision → 结束时 finalize_task。',
      'bugfix 与 unknown 任务可以使用已有约定，但不会写入偏好或功能档案；不要试图绕过该限制。',
      'reasonSource 必须真实：只有用户明确表达才用 user_explicit，模型推测用 unknown，不要替用户编造动机。',
      '只有实际核对过代码后，才应把功能说明标记为 verified；未执行的检查不要写成通过。',
    ].join('\n'),
  },
);

// --- Project & task lifecycle ----------------------------------------------

server.registerTool(
  'project_init',
  {
    title: '注册项目',
    description: '注册项目目录并返回项目信息；重复调用安全。',
    inputSchema: S.projectInitSchema,
  },
  async (args) => {
    try {
      const project = ensureProject(db, { rootPath: args.rootPath, name: args.name });
      return json({
        project,
        conventions: listConventions(db, project.id).length,
        message: '项目已注册。可用 project_add_convention 记录项目约定。',
      });
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  'project_add_convention',
  {
    title: '记录项目约定',
    description: '记录项目的技术栈、分层、命名、组件用法或测试方式等约定。',
    inputSchema: S.addConventionSchema,
  },
  async (args) => {
    try {
      const project = resolveProjectRef(args.projectRoot);
      const id = addConvention(db, project.id, {
        category: args.category,
        content: args.content,
        source: args.source,
      });
      return json({ conventionId: id, total: listConventions(db, project.id).length });
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  'begin_task',
  {
    title: '开始任务',
    description:
      '开始一次开发任务并确定学习范围。feature / refactor 记录知识与候选偏好；bugfix 只读不写；unknown 默认不写入。',
    inputSchema: S.beginTaskSchema,
  },
  async (args) => {
    try {
      const project = resolveProjectRef(args.projectRoot);
      const featureId = args.featureSlug ? requireFeature(project.id, args.featureSlug).id : null;
      const task = beginTask(db, {
        projectId: project.id,
        title: args.title,
        taskType: args.taskType,
        featureId,
        intent: args.intent,
        inScope: args.inScope,
        outOfScope: args.outOfScope,
        constraints: args.constraints,
        doneCriteria: args.doneCriteria,
        stack: args.stack,
        scene: args.scene,
      });
      return json({
        task,
        policy: task.policy,
        next: '开发前调用 get_context 读取相关约定、偏好与功能记录。',
      });
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  'get_context',
  {
    title: '读取任务上下文',
    description: '按任务读取项目约定、适用偏好、关联功能与关键决定；未给 taskId 时列出未完成任务。',
    inputSchema: S.getContextSchema,
  },
  async (args) => {
    try {
      if (!args.taskId) {
        if (!args.projectRoot) throw new Error('需要提供 taskId 或 projectRoot。');
        const project = findProjectByPath(db, args.projectRoot);
        if (!project) {
          return json({ project: null, tasks: [], message: '项目尚未注册，请先调用 project_init 或 begin_task。' });
        }
        return json({ project, tasks: findOpenTasks(db, project.id) });
      }
      const task = requireTask(args.taskId);
      return json(buildTaskContext(db, task, { maxChars: args.maxChars ?? 12000 }));
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  'update_task',
  {
    title: '更新任务',
    description: '更新任务的目标、范围、完成条件或状态。修改 taskType 会同时重算学习范围。',
    inputSchema: S.taskUpdateSchema,
  },
  async (args) => {
    try {
      const task = requireTask(args.taskId);
      const featureId = args.featureSlug ? requireFeature(task.projectId, args.featureSlug).id : undefined;
      const updated = updateTask(db, task.id, {
        status: args.status,
        taskType: args.taskType,
        intent: args.intent,
        inScope: args.inScope,
        outOfScope: args.outOfScope,
        constraints: args.constraints,
        doneCriteria: args.doneCriteria,
        outcome: args.outcome,
        verification: args.verification,
        featureId,
        stack: args.stack,
        scene: args.scene,
      });
      return json({ task: updated });
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  'save_checkpoint',
  {
    title: '保存进度',
    description: '保存任务进度、已改动内容与未完成事项，用于中断后恢复。',
    inputSchema: S.saveCheckpointSchema,
  },
  async (args) => {
    try {
      const id = saveCheckpoint(db, args.taskId, {
        summary: args.summary,
        changed: args.changed,
        remaining: args.remaining,
      });
      return json({ checkpointId: id, savedAt: nowIso(), checkpoints: listCheckpoints(db, args.taskId).length });
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  'record_decision',
  {
    title: '记录关键决定',
    description:
      '记录采用方案及其理由。reasonSource 必须真实；bugfix 与 unknown 任务会被拒绝。没有依据时不要填写理由。',
    inputSchema: S.recordDecisionSchema,
  },
  async (args) => {
    try {
      const task = requireTask(args.taskId);
      assertCanWriteDecisions(task);
      const featureId = args.featureSlug ? requireFeature(task.projectId, args.featureSlug).id : task.featureId;
      const decision = addDecision(db, {
        projectId: task.projectId,
        featureId,
        taskId: task.id,
        title: args.title,
        choice: args.choice,
        reason: args.reason,
        reasonSource: args.reasonSource,
        consequence: args.consequence,
        evidence: args.evidence,
      });
      return json({
        decision,
        note: decision.reason ? undefined : '未记录理由：后续查询时会显示为未知，不会推测。',
      });
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  'finalize_task',
  {
    title: '结束任务',
    description: '结束任务并写入已核对的功能说明；只有实际核对过的内容才应提交为 statements。',
    inputSchema: S.finalizeTaskSchema,
  },
  async (args) => {
    try {
      const task = requireTask(args.taskId);
      if (args.statements && args.statements.length > 0) assertCanWriteFeatureStatements(task);

      const featureIds = new Map<string, string>();
      const featureIdFor = (slug: string): string => {
        const cached = featureIds.get(slug);
        if (cached) return cached;
        const feature = requireFeature(task.projectId, slug);
        featureIds.set(slug, feature.id);
        return feature.id;
      };

      const statements = (args.statements ?? []).map((statement) => ({
        featureId: featureIdFor(statement.featureSlug),
        section: statement.section,
        content: statement.content,
        relativePaths: statement.relativePaths,
      }));

      if (args.feature) {
        upsertFeature(db, {
          projectId: task.projectId,
          slug: args.feature.slug,
          title: args.feature.title,
          purpose: args.feature.purpose,
          boundary: args.feature.boundary,
        });
      }

      const result = finalizeTask(db, {
        task,
        outcome: args.outcome,
        verification: args.verification,
        statements,
      });
      const updated = updateTask(db, task.id, {
        status: 'done',
        outcome: args.outcome,
        verification: args.verification,
      });
      return json({ task: updated, result });
    } catch (error) {
      return failure(error);
    }
  },
);

// --- Feature knowledge ------------------------------------------------------

server.registerTool(
  'query_feature',
  {
    title: '查询功能',
    description: '查询功能当前的实现说明、关键决定与历史记录。区分当前说明与已替代的历史。',
    inputSchema: S.queryFeatureSchema,
  },
  async (args) => {
    try {
      const project = findProjectByPath(db, args.projectRoot);
      if (!project) throw new Error(`项目未注册：${args.projectRoot}`);
      const resolution = resolveFeature(db, project.id, args.query, args.includeHistory ?? false);
      if (!resolution) {
        return json({
          found: false,
          message: '未找到相关功能记录。可以先用 begin_task 建立功能档案，或调整关键词。',
          features: listFeatures(db, project.id).map((f) => ({ slug: f.slug, title: f.title })),
        });
      }
      return json({
        found: true,
        dossier: resolution.dossier,
        ambiguous: resolution.ambiguous.map((hit) => ({ slug: hit.feature.slug, title: hit.feature.title, score: hit.score })),
        caution:
          resolution.dossier.statements.some((s) => s.reviewState !== 'verified')
            ? '部分说明尚未核对或已标记待复核，请结合当前代码确认后再作为事实使用。'
            : undefined,
      });
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  'review_statement',
  {
    title: '更新说明核对状态',
    description: '在重新核对代码后更新功能说明的状态；只有真正核对通过才用 verified。',
    inputSchema: S.reviewStatementSchema,
  },
  async (args) => {
    try {
      reviewStatement(db, args.statementId, args.reviewState);
      return json({ statementId: args.statementId, reviewState: args.reviewState, reviewedAt: nowIso() });
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  'stale_check',
  {
    title: '检查过时说明',
    description: '对比记录时保存的代码指纹与当前文件，列出可能需要重新核对的功能说明。',
    inputSchema: S.staleCheckSchema,
  },
  async (args) => {
    try {
      const project = findProjectByPath(db, args.projectRoot);
      if (!project) throw new Error(`项目未注册：${args.projectRoot}`);
      const reports = detectStale(db, project.id);
      return json({
        projectId: project.id,
        staleCount: reports.length,
        reports,
        note: '未触发提示不等于记录一定准确：未被证据覆盖的依赖变化无法检测。',
      });
    } catch (error) {
      return failure(error);
    }
  },
);

// --- Preferences ------------------------------------------------------------

server.registerTool(
  'propose_preference',
  {
    title: '提出偏好候选',
    description:
      '从允许学习的任务中沉淀偏好。默认写入 candidate；只有用户明确要求长期采用时才用 confirm=true 写入 confirmed。',
    inputSchema: S.proposePreferenceSchema,
  },
  async (args) => {
    try {
      const task = requireTask(args.taskId);
      assertCanLearnPreferences(task);
      const preference = addPreference(db, {
        title: args.title,
        content: args.content,
        scope: args.scope,
        projectId: args.scope === 'global' ? null : task.projectId,
        stack: args.stack,
        scene: args.scene,
        status: args.confirm ? 'confirmed' : 'candidate',
        evidence: args.evidence,
      });
      return json({
        preference,
        note: args.confirm
          ? '已按用户明确要求确认为长期偏好。'
          : '已记录为候选偏好；未确认前不会作为强制约束注入上下文。',
      });
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  'manage_preference',
  {
    title: '管理偏好',
    description: '列出、确认、撤销或替代偏好。撤销后该规则不再提供给新任务。',
    inputSchema: S.managePreferenceSchema,
  },
  async (args) => {
    try {
      switch (args.action) {
        case 'list': {
          return json({ preferences: listPreferences(db) });
        }
        case 'confirm': {
          if (!args.preferenceId) throw new Error('confirm 需要 preferenceId。');
          return json({ preference: setPreferenceStatus(db, args.preferenceId, 'confirmed') });
        }
        case 'revoke': {
          if (!args.preferenceId) throw new Error('revoke 需要 preferenceId。');
          return json({ preference: revokePreference(db, args.preferenceId) });
        }
        case 'supersede': {
          if (!args.preferenceId) throw new Error('supersede 需要 preferenceId。');
          if (!args.title || !args.content) throw new Error('supersede 需要新的 title 与 content。');
          return json({
            preference: supersedePreference(db, args.preferenceId, {
              title: args.title,
              content: args.content,
              scope: args.scope,
            }),
          });
        }
        default:
          throw new Error(`未知操作：${String(args.action)}`);
      }
    } catch (error) {
      return failure(error);
    }
  },
);

// --- Export & data ----------------------------------------------------------

server.registerTool(
  'export_context',
  {
    title: '导出任务交接文档',
    description: '把任务上下文导出为 Markdown，便于其他模型或人工接手。',
    inputSchema: S.exportContextSchema,
  },
  async (args) => {
    try {
      const task = requireTask(args.taskId);
      const markdown = exportTaskMarkdown(db, task);
      const target = args.outFile
        ? path.resolve(args.outFile)
        : path.join(paths.exportDir, `${task.id}.md`);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, markdown, 'utf8');
      return json({ file: target, bytes: Buffer.byteLength(markdown, 'utf8') });
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  'data_info',
  {
    title: '数据位置与容量',
    description: '返回数据目录、数据库位置与容量信息，便于确认个人数据存放位置。',
    inputSchema: S.dataInfoSchema,
  },
  async (args) => {
    try {
      const size = dataDirSize(paths.dataDir);
      const payload: Record<string, unknown> = {
        dataDir: paths.dataDir,
        dbFile: paths.dbFile,
        exportDir: paths.exportDir,
        bytes: size.bytes,
        humanSize: formatBytes(size.bytes),
        files: size.files,
        note: '程序位置与个人数据位置相互独立；Cloonex 默认不向开发者服务端上传这些内容。',
      };
      if (args.detail) {
        payload.counts = {
          projects: db.get('SELECT COUNT(*) AS c FROM project')?.c,
          features: db.get('SELECT COUNT(*) AS c FROM feature')?.c,
          tasks: db.get('SELECT COUNT(*) AS c FROM task')?.c,
          decisions: db.get('SELECT COUNT(*) AS c FROM decision')?.c,
          preferences: db.get('SELECT COUNT(*) AS c FROM preference')?.c,
          statements: db.get('SELECT COUNT(*) AS c FROM feature_statement')?.c,
          evidence: db.get('SELECT COUNT(*) AS c FROM evidence')?.c,
        };
      }
      return json(payload);
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  'list_projects',
  {
    title: '列出项目',
    description: '列出已注册的项目。',
    inputSchema: S.projectListSchema,
  },
  async () => {
    try {
      return json({ projects: listProjects(db) });
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  'list_tasks',
  {
    title: '列出任务',
    description: '列出项目的任务历史。',
    inputSchema: S.taskListSchema,
  },
  async (args) => {
    try {
      const project = findProjectByPath(db, args.projectRoot);
      if (!project) throw new Error(`项目未注册：${args.projectRoot}`);
      return json({ tasks: listTasks(db, project.id, args.limit ?? 20) });
    } catch (error) {
      return failure(error);
    }
  },
);

export { server, db };

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  process.stderr.write(`Cloonex MCP server failed: ${String(error)}\n`);
  process.exit(1);
});
