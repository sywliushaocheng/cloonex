import fs from 'node:fs';
import type { Db } from '../db/database.js';
import { statementFreshness } from './freshness.js';

export function projectHealth(db: Db, projectId?: string, checkFiles = false) {
  const projects = projectId ? db.all('SELECT * FROM project WHERE id=?', [projectId]) : db.all('SELECT * FROM project');
  if (projectId && !projects.length) throw new Error('找不到项目。');
  const cutoff = new Date(Date.now() - 30 * 86400000).toISOString();
  const cache = new Map<string, string | null>();
  return {
    integrity: Object.values(db.get('PRAGMA quick_check') ?? {})[0],
    foreignKeyIssues: db.all('PRAGMA foreign_key_check').length,
    checkedAt: new Date().toISOString(),
    projects: projects.map((project) => {
      const id = String(project.id);
      const statements = db.all("SELECT s.id,s.review_state FROM feature_statement s JOIN feature f ON s.feature_id=f.id WHERE f.project_id=? AND s.state='current'", [id]);
      const freshness: Record<string, number> = {};
      if (checkFiles) for (const statement of statements) {
        const status = statementFreshness(db, String(statement.id), cache).status;
        freshness[status] = (freshness[status] ?? 0) + 1;
      }
      return { id, name: project.name, rootPath: project.root_path, pathExists: fs.existsSync(String(project.root_path)),
        conventions: Number(db.get("SELECT COUNT(*) n FROM project_convention WHERE project_id=? AND status='active'", [id])?.n),
        statements: statements.length, freshness: checkFiles ? freshness : undefined,
        openTasks: db.all(`SELECT t.id,t.title,t.status,t.updated_at,(SELECT COUNT(*) FROM checkpoint c WHERE c.task_id=t.id) checkpoints
          FROM task t WHERE project_id=? AND status IN ('open','blocked') ORDER BY updated_at`, [id])
          .map((task) => ({ ...task, olderThan30Days: String(task.updated_at) < cutoff })),
        unlinkedCompletedTasks: Number(db.get(`SELECT COUNT(*) n FROM task WHERE project_id=? AND status='done'
          AND task_type IN ('feature','refactor') AND feature_id IS NULL`, [id])?.n),
      };
    }),
    note: checkFiles ? '文件指纹变化表示需要复核，不代表说明内容必然错误。' : '未扫描文件；需要时添加 --check-files。',
  };
}
