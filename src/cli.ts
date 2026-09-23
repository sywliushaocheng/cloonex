#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { openDb, resolvePaths, resolveDataDir, writeConfig, readConfig, dataDirSize, formatBytes, DEFAULT_DATA_DIR } from './db/storage.js';
import { listProjects, findProjectByPath, listConventions } from './domain/project.js';
import { getTask, listTasks, findOpenTasks } from './domain/task.js';
import { listFeatures } from './domain/feature.js';
import { listPreferences, revokePreference, setPreferenceStatus } from './domain/preference.js';
import { detectStale } from './domain/context.js';
import { exportTaskMarkdown } from './export/markdown.js';

/**
 * Cloonex CLI.
 *
 * Scope note: the primary interface is the MCP server. The CLI exists so users
 * can inspect their own data, see where it lives, and manage capacity without
 * depending on a model or a GUI (product doc §10.2, §10.3).
 */
const HELP = `Cloonex - 本地开发思维与项目知识库

用法：cloonex <命令> [选项]

命令：
  init [--data-dir <路径>]      初始化数据目录并写入配置
  info [--detail]               显示数据位置与容量
  projects                      列出已注册项目
  project <路径>                显示单个项目的记录概况
  tasks <项目路径>              列出项目任务
  show <任务ID>                 显示任务的当前上下文
  export <任务ID> [--out <文件>] 导出任务交接 Markdown
  stale <项目路径>              检查功能说明是否与代码不一致
  preferences [--all]           列出偏好
  preference-confirm <ID>       确认候选偏好
  preference-revoke <ID>        撤销偏好，使其不再提供给新任务
  mcp-config                    输出 Codex 接入所需的 TOML 配置片段
  install-skill [--target <目录>] 安装 Cloonex 开发流程技能
  help                          显示本帮助

数据位置优先级：CLOONEX_DATA_DIR 环境变量 > 配置文件 > ${DEFAULT_DATA_DIR}
`;

function parseFlags(argv: string[]): { positional: string[]; flags: Map<string, string | boolean> } {
  const positional: string[] = [];
  const flags = new Map<string, string | boolean>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        flags.set(key, next);
        i += 1;
      } else {
        flags.set(key, true);
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function out(line = ''): void {
  process.stdout.write(`${line}\n`);
}

function requireTaskId(positional: string[], usage: string): string {
  const id = positional[0];
  if (!id) throw new Error(`缺少任务 ID。用法：${usage}`);
  return id;
}

function main(): void {
  const [command, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseFlags(rest);

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    out(HELP.trimEnd());
    return;
  }

  if (command === 'init') {
    const dataDirFlag = flags.get('data-dir');
    const dataDir = typeof dataDirFlag === 'string' ? path.resolve(dataDirFlag) : resolveDataDir();
    fs.mkdirSync(dataDir, { recursive: true });
    const configFile = writeConfig({ dataDir });
    const db = openDb({ dataDir });
    db.close();
    const size = dataDirSize(dataDir);
    out(`数据目录：${dataDir}`);
    out(`配置文件：${configFile}`);
    out(`数据库：${resolvePaths(dataDir).dbFile}`);
    out(`当前占用：${formatBytes(size.bytes)}`);
    out('提示：程序目录与个人数据目录相互独立，移动数据目录后请重新执行 init。');
    return;
  }

  // Everything below needs an existing database.
  const db = openDb({ mustExist: true });
  try {
    switch (command) {
      case 'info': {
        const paths = resolvePaths();
        const size = dataDirSize(paths.dataDir);
        out(`数据目录：${paths.dataDir}`);
        out(`数据库：${paths.dbFile}`);
        out(`导出目录：${paths.exportDir}`);
        out(`占用：${formatBytes(size.bytes)}（${size.files} 个文件）`);
        out(`默认不收集：代码、偏好、对话与项目记录默认保存在本地。`);
        if (flags.has('detail')) {
          out('');
          out('记录数：');
          const counts: Array<[string, string]> = [
            ['项目', 'project'],
            ['功能', 'feature'],
            ['任务', 'task'],
            ['关键决定', 'decision'],
            ['偏好', 'preference'],
            ['功能说明', 'feature_statement'],
            ['证据', 'evidence'],
          ];
          for (const [label, table] of counts) {
            const row = db.get(`SELECT COUNT(*) AS c FROM ${table}`);
            out(`  ${label}：${String(row?.c ?? 0)}`);
          }
        }
        return;
      }

      case 'projects': {
        const projects = listProjects(db);
        if (projects.length === 0) {
          out('尚未注册任何项目。请在 Codex 中调用 project_init，或先在目标项目里使用 Cloonex MCP 工具。');
          return;
        }
        for (const project of projects) {
          const open = findOpenTasks(db, project.id).length;
          const features = listFeatures(db, project.id).length;
          out(`${project.name}`);
          out(`  路径：${project.rootPath}`);
          out(`  功能：${features}　未完成任务：${open}`);
        }
        return;
      }

      case 'project': {
        const rootPath = positional[0];
        if (!rootPath) throw new Error('用法：cloonex project <项目路径>');
        const project = findProjectByPath(db, rootPath);
        if (!project) {
          out(`项目未注册：${rootPath}`);
          return;
        }
        out(`项目：${project.name}`);
        out(`路径：${project.rootPath}`);
        if (project.gitHead) out(`Git HEAD：${project.gitHead}`);
        const conventions = listConventions(db, project.id);
        out('');
        out(`项目约定（${conventions.length}）：`);
        for (const convention of conventions) out(`  [${convention.category}] ${convention.content}`);
        const features = listFeatures(db, project.id);
        out('');
        out(`功能档案（${features.length}）：`);
        for (const feature of features) out(`  ${feature.slug} - ${feature.title}`);
        return;
      }

      case 'tasks': {
        const rootPath = positional[0];
        if (!rootPath) throw new Error('用法：cloonex tasks <项目路径>');
        const project = findProjectByPath(db, rootPath);
        if (!project) {
          out(`项目未注册：${rootPath}`);
          return;
        }
        const tasks = listTasks(db, project.id, 50);
        if (tasks.length === 0) {
          out('没有任务记录。');
          return;
        }
        for (const task of tasks) {
          out(`${task.id}  [${task.taskType}] ${task.status}  ${task.title}`);
          out(`  学习：${task.learningState}　更新：${task.updatedAt}`);
        }
        return;
      }

      case 'show': {
        const task = getTask(db, requireTaskId(positional, 'cloonex show <任务ID>'));
        if (!task) throw new Error(`未找到任务：${positional[0]}`);
        const markdown = exportTaskMarkdown(db, task);
        out(markdown);
        return;
      }

      case 'export': {
        const task = getTask(db, requireTaskId(positional, 'cloonex export <任务ID> [--out <文件>]'));
        if (!task) throw new Error(`未找到任务：${positional[0]}`);
        const markdown = exportTaskMarkdown(db, task);
        const outFlag = flags.get('out');
        const target = typeof outFlag === 'string' ? path.resolve(outFlag) : path.join(resolvePaths().exportDir, `${task.id}.md`);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, markdown, 'utf8');
        out(`已导出：${target}`);
        return;
      }

      case 'stale': {
        const rootPath = positional[0];
        if (!rootPath) throw new Error('用法：cloonex stale <项目路径>');
        const project = findProjectByPath(db, rootPath);
        if (!project) {
          out(`项目未注册：${rootPath}`);
          return;
        }
        const reports = detectStale(db, project.id);
        if (reports.length === 0) {
          out('没有检测到需要重新核对的说明。');
          out('注意：未被证据覆盖的变化无法检测，这不等于记录一定准确。');
          return;
        }
        out(`检测到 ${reports.length} 条说明需要重新核对：`);
        for (const report of reports) {
          out('');
          out(`[${report.section}] ${report.content}`);
          out(`  原因：${report.reason}`);
          for (const evidence of report.evidence) {
            if (evidence.status !== 'unchanged' && evidence.status !== 'no-fingerprint') {
              out(`  - ${evidence.relativePath ?? '(无路径)'}：${evidence.status}${evidence.detail ? `（${evidence.detail}）` : ''}`);
            }
          }
        }
        return;
      }

      case 'preferences': {
        const all = listPreferences(db, flags.has('all'));
        if (all.length === 0) {
          out('没有偏好记录。');
          return;
        }
        for (const preference of all) {
          const scope = preference.projectId ? `${preference.scope}@${preference.projectId}` : preference.scope;
          out(`${preference.id}  [${preference.status}] ${preference.title}`);
          out(`  范围：${scope}　证据强度：${preference.strength}`);
          out(`  ${preference.content}`);
        }
        return;
      }

      case 'preference-confirm': {
        const id = requireTaskId(positional, 'cloonex preference-confirm <ID>');
        const preference = setPreferenceStatus(db, id, 'confirmed');
        out(`已确认：${preference.title}`);
        return;
      }

      case 'preference-revoke': {
        const id = requireTaskId(positional, 'cloonex preference-revoke <ID>');
        const preference = revokePreference(db, id);
        out(`已撤销：${preference.title}`);
        out('该规则不再提供给新任务。');
        return;
      }

      case 'mcp-config': {
        const paths = resolvePaths();
        const serverEntry = path.resolve(import.meta.dirname, 'mcp', 'server.js');
        out('# 将以下内容加入 Codex 配置 config.toml');
        out('');
        out('[mcp_servers.cloonex]');
        out('type = "stdio"');
        out('command = ' + JSON.stringify(process.execPath));
        out('args = [' + JSON.stringify(serverEntry.replace(/\\/g, '/')) + ']');
        out('');
        out('[mcp_servers.cloonex.env]');
        out('CLOONEX_DATA_DIR = ' + JSON.stringify(paths.dataDir.replace(/\\/g, '/')));
        out('');
        out('# 说明：');
        out('# 1. CLOONEX_DATA_DIR 是个人数据目录，可改到 D 盘等位置，与程序安装位置无关。');
        out('# 2. 修改配置后需要在 Codex 中审阅并信任该 MCP 服务。');
        out('# 3. 首次使用前先运行：cloonex init --data-dir <数据目录>');
        return;
      }

      case 'install-skill': {
        const targetFlag = flags.get('target');
        const codexHome = process.env.CODEX_HOME ?? path.join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.codex');
        const targetRoot = typeof targetFlag === 'string' ? path.resolve(targetFlag) : path.join(codexHome, 'skills');
        const source = path.resolve(import.meta.dirname, '..', '..', 'skills', 'cloonex', 'SKILL.md');
        if (!fs.existsSync(source)) throw new Error('未找到技能源文件：' + source);
        const targetDir = path.join(targetRoot, 'cloonex');
        fs.mkdirSync(targetDir, { recursive: true });
        const targetFile = path.join(targetDir, 'SKILL.md');
        fs.copyFileSync(source, targetFile);
        out('已安装技能：' + targetFile);
        out('在 Codex 中即可按 Cloonex 流程开发。');
        return;
      }

      default:
        out(`未知命令：${command}`);
        out('');
        out(HELP.trimEnd());
        process.exitCode = 1;
    }
  } finally {
    db.close();
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
