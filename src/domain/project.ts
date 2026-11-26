import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '../db/database.js';
import { newId, normalisePath, nowIso } from '../db/util.js';
import { fingerprintFile, gitHead, resolveInsideProject } from './code.js';
import type { ConventionRow, ProjectRow } from './types.js';

export interface ProjectRef {
  id: string;
  name: string;
  rootPath: string;
  createdAt: string;
  updatedAt: string;
  gitHead: string | null;
}

function toProjectRef(row: Record<string, unknown>): ProjectRef {
  const rootPath = String(row.root_path);
  const project: ProjectRef = {
    id: String(row.id),
    name: String(row.name),
    rootPath,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    gitHead: null,
  };
  project.gitHead = gitHead(rootPath);
  return project;
}

export function findProjectByPath(db: Db, rootPath: string): ProjectRef | null {
  const normalised = normalisePath(path.resolve(rootPath));
  const row = db.get('SELECT * FROM project WHERE root_path = ?', [normalised]);
  return row ? toProjectRef(row) : null;
}

export function listProjects(db: Db): ProjectRef[] {
  return db.all('SELECT * FROM project ORDER BY updated_at DESC').map(toProjectRef);
}

export function getProject(db: Db, id: string): ProjectRef | null {
  const row = db.get('SELECT * FROM project WHERE id = ?', [id]);
  return row ? toProjectRef(row) : null;
}

export interface EnsureProjectInput {
  rootPath: string;
  name?: string;
}

/** Idempotent: registers a project the first time, returns it afterwards. */
export function ensureProject(db: Db, input: EnsureProjectInput): ProjectRef {
  const resolved = path.resolve(input.rootPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Project directory does not exist: ${resolved}`);
  }
  if (!fs.statSync(resolved).isDirectory()) {
    throw new Error(`Project path is not a directory: ${resolved}`);
  }
  const existing = findProjectByPath(db, resolved);
  if (existing) return existing;

  const id = newId('prj');
  const name = (input.name ?? path.basename(resolved)) || 'project';
  const timestamp = nowIso();
  db.run(
    'INSERT INTO project (id, name, root_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    [id, name, normalisePath(resolved), timestamp, timestamp],
  );
  return toProjectRef({
    id,
    name,
    root_path: normalisePath(resolved),
    created_at: timestamp,
    updated_at: timestamp,
  });
}

export function renameProject(db: Db, projectId: string, name: string): void {
  db.run('UPDATE project SET name = ?, updated_at = ? WHERE id = ?', [name, nowIso(), projectId]);
}

export interface ConventionInput {
  category: string;
  content: string;
  source?: string;
  relativePath?: string;
  fingerprint?: string;
}

export function addConvention(db: Db, projectId: string, input: ConventionInput): string {
  const id = newId('cnv');
  const timestamp = nowIso();
  db.run(
    `INSERT INTO project_convention
       (id, project_id, category, content, source, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
    [id, projectId, input.category, input.content, input.source ?? 'unknown', timestamp, timestamp],
  );
  if (input.relativePath) db.run('UPDATE project_convention SET relative_path=?,fingerprint=? WHERE id=?',
    [input.relativePath, input.fingerprint ?? null, id]);
  return id;
}

export function moveProject(db: Db, projectId: string, newRoot: string): ProjectRef {
  const project = getProject(db, projectId);
  if (!project) throw new Error('找不到项目。');
  const root = fs.realpathSync(path.resolve(newRoot));
  if (!fs.statSync(root).isDirectory()) throw new Error('新路径不是目录。');
  const duplicate = findProjectByPath(db, root);
  if (duplicate && duplicate.id !== projectId) throw new Error('新目录已关联其他项目，不能自动合并。');
  db.run('UPDATE project SET root_path=?,updated_at=? WHERE id=?', [normalisePath(root), nowIso(), projectId]);
  return getProject(db, projectId)!;
}

export function importProjectRules(db: Db, projectId: string, relativePath = 'AGENTS.md', apply = false) {
  const project = getProject(db, projectId);
  if (!project) throw new Error('找不到项目。');
  const absolute = resolveInsideProject(project.rootPath, relativePath);
  if (!absolute || !fs.statSync(absolute).isFile()) throw new Error('规则文件必须位于项目内。');
  if (fs.statSync(absolute).size > 64 * 1024) throw new Error('规则文件超过64KB，请先拆分。');
  const content = fs.readFileSync(absolute, 'utf8').trim();
  if (!content) throw new Error('规则文件为空。');
  const fingerprint = fingerprintFile(absolute)!;
  let id: string | undefined;
  if (apply) db.transaction(() => {
    const same = db.get("SELECT id FROM project_convention WHERE project_id=? AND relative_path=? AND fingerprint=? AND status='active'", [projectId, relativePath, fingerprint]);
    if (same) { id = String(same.id); return; }
    db.run("UPDATE project_convention SET status='historical',updated_at=? WHERE project_id=? AND relative_path=? AND status='active'", [nowIso(), projectId, relativePath]);
    id = addConvention(db, projectId, { category: 'project-rule', content, source: relativePath, relativePath, fingerprint });
  });
  return { projectId, relativePath, fingerprint, content, applied: apply, conventionId: id };
}

export function addProjectGroup(db: Db, name: string, projectIds: string[]): void {
  if (!name.trim() || !projectIds.length) throw new Error('需要项目组名称和项目。');
  db.transaction(() => {
    for (const id of projectIds) {
      if (!getProject(db, id)) throw new Error(`找不到项目：${id}`);
      db.run('INSERT OR IGNORE INTO project_group(name,project_id) VALUES(?,?)', [name.trim(), id]);
    }
  });
}

export function listConventions(db: Db, projectId: string, includeRetired = false): ConventionRow[] {
  const rows = includeRetired
    ? db.all('SELECT * FROM project_convention WHERE project_id = ? ORDER BY category, created_at', [projectId])
    : db.all(
        "SELECT * FROM project_convention WHERE project_id = ? AND status = 'active' ORDER BY category, created_at",
        [projectId],
      );
  return rows as unknown as ConventionRow[];
}

export function refreshProjectTimestamp(db: Db, projectId: string): void {
  db.run('UPDATE project SET updated_at = ? WHERE id = ?', [nowIso(), projectId]);
}

export type { ProjectRow };
