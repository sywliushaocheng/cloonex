import { buildTaskContext, type TaskContext } from '../domain/context.js';
import type { Db } from '../db/database.js';
import type { TaskView } from '../domain/task.js';

/**
 * Markdown handover export (product doc §9.2).
 *
 * Deliberately plain text: the point is that a *different* model or a human can
 * pick the task up without Cloonex being installed or understood.
 */
export function renderTaskContext(context: TaskContext): string {
  const lines: string[] = [];
  const { project, task } = context;

  lines.push(`# ${task.title}`);
  lines.push('');
  lines.push(`- 项目：${project.name}`);
  lines.push(`- 项目路径：\`${project.rootPath}\``);
  lines.push(`- 任务类型：${task.taskType}`);
  lines.push(`- 学习状态：${task.learning}`);
  if (project.gitHead) lines.push(`- Git HEAD：\`${project.gitHead}\``);
  lines.push(`- 生成时间：${new Date().toISOString()}`);
  lines.push('');
  lines.push(`> ${context.policyRationale}`);
  lines.push('');

  lines.push('## 任务说明');
  const taskFields: Array<[string, string | null]> = [
    ['目标', task.intent],
    ['范围内', task.inScope],
    ['范围外', task.outOfScope],
    ['约束', task.constraints],
    ['完成条件', task.doneCriteria],
  ];
  let wroteField = false;
  for (const [label, value] of taskFields) {
    if (value) {
      lines.push(`- **${label}**：${value}`);
      wroteField = true;
    }
  }
  if (!wroteField) lines.push('- 尚未记录。');
  lines.push('');

  for (const section of context.sections) {
    lines.push(`## ${section.title}`);
    if (section.items.length === 0) {
      lines.push('');
      lines.push('_无记录_');
    } else {
      lines.push('');
      for (const item of section.items) lines.push(`- ${item}`);
      if (section.omitted > 0) lines.push(`- （因上下文预算省略 ${section.omitted} 条）`);
    }
    lines.push('');
  }

  if (context.warnings.length > 0) {
    lines.push('## 需要注意');
    lines.push('');
    for (const warning of context.warnings) lines.push(`- ⚠️ ${warning}`);
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push('本文件由 Cloonex 生成，用于在新会话或其他模型中接手任务。');
  lines.push('记录中标注为候选、待复核或未知的内容不构成确定事实。');
  return lines.join('\n');
}

export function exportTaskMarkdown(db: Db, task: TaskView): string {
  return renderTaskContext(buildTaskContext(db, task));
}
