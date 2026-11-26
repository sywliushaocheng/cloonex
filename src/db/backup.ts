import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { z } from 'zod';
import { Db } from './database.js';
import { openDb, resolvePaths } from './storage.js';
import { VERSION, DATABASE_VERSION } from '../version.js';

const TABLES = ['project', 'project_convention', 'task', 'feature', 'feature_statement', 'decision', 'preference',
  'evidence', 'statement_evidence', 'decision_evidence', 'preference_evidence', 'checkpoint', 'task_code_state'];
const OPTIONAL_TABLES = ['task_feature', 'statement_review', 'label_alias', 'project_group', 'feature_alias'];
const digest = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
const fileSchema = z.object({ path: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/), base64: z.string() });
const archiveSchema = z.object({
  format: z.literal('cloonex-backup'), formatVersion: z.literal(1), appVersion: z.string(),
  schemaVersion: z.number().int().min(1).max(DATABASE_VERSION), createdAt: z.string(),
  counts: z.record(z.string(), z.number().int().nonnegative()), database: fileSchema,
  files: z.array(fileSchema).max(10000),
});
type Archive = z.infer<typeof archiveSchema>;

function checkExportPath(value: string, seen: Set<string>): void {
  if (!value.startsWith('exports/') || value.includes('\\') || value.includes(':') || value.includes('\0') ||
    value.split('/').some((segment) => !segment || segment === '.' || segment === '..' ||
      /[. ]$/.test(segment) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment))) {
    throw new Error(`迁移包包含不安全的文件路径：${value}`);
  }
  const key = value.toLowerCase();
  if (seen.has(key)) throw new Error('迁移包包含重复文件路径。');
  seen.add(key);
}

function counts(db: Db): Record<string, number> {
  return Object.fromEntries([...TABLES, ...OPTIONAL_TABLES.filter((table) => db.get("SELECT name FROM sqlite_master WHERE type='table' AND name=?", [table]))]
    .map((table) => [table, Number(db.get(`SELECT COUNT(*) n FROM ${table}`)?.n ?? 0)]));
}

function validateDatabase(file: string): { counts: Record<string, number>; schemaVersion: number } {
  const db = new Db(file, { readOnly: true, fileMustExist: true });
  try {
    if (Object.values(db.get('PRAGMA integrity_check') ?? {})[0] !== 'ok') throw new Error('迁移包数据库完整性检查失败。');
    if (db.all('PRAGMA foreign_key_check').length) throw new Error('迁移包数据库关联检查失败。');
    if (db.get("SELECT name FROM sqlite_master WHERE type IN ('trigger','view')")) throw new Error('迁移包包含非标准数据库对象。');
    for (const table of TABLES) {
      if (!db.get("SELECT name FROM sqlite_master WHERE type='table' AND name=?", [table])) {
        throw new Error(`不是完整的 Cloonex 知识库，缺少表：${table}`);
      }
    }
    const schemaVersion = Number(db.get("SELECT value FROM meta WHERE key='schema_version'")?.value ?? 1);
    if (!Number.isInteger(schemaVersion) || schemaVersion < 1 || schemaVersion > DATABASE_VERSION) {
      throw new Error('迁移包由较新版本创建，请先升级 Cloonex。');
    }
    return { counts: counts(db), schemaVersion };
  } finally { db.close(); }
}

function encode(file: string, relative: string) {
  const data = fs.readFileSync(file);
  return { path: relative, sha256: digest(data), base64: data.toString('base64') };
}

function decode(file: z.infer<typeof fileSchema>): Buffer {
  if (file.base64.length % 4 || /[^A-Za-z0-9+/=]/.test(file.base64)) {
    throw new Error('迁移包文件编码无效。');
  }
  const data = Buffer.from(file.base64, 'base64');
  if (data.toString('base64') !== file.base64) throw new Error('迁移包文件编码无效。');
  if (digest(data) !== file.sha256) throw new Error(`迁移包校验失败：${file.path}`);
  return data;
}

function readArchive(file: string): Archive {
  if (fs.statSync(file).size > 256 * 1024 * 1024) throw new Error('迁移包超过 256 MB 压缩大小上限。');
  const data = gunzipSync(fs.readFileSync(file), { maxOutputLength: 512 * 1024 * 1024 });
  const archive = archiveSchema.parse(JSON.parse(data.toString('utf8')));
  if (archive.database.path !== 'cloonex.sqlite') throw new Error('迁移包数据库名称无效。');
  const seen = new Set<string>();
  for (const item of archive.files) {
    // A portable archive accepts ordinary relative exports paths only. No drive
    // paths, dot segments, Windows device names, ADS, links or duplicate names.
    checkExportPath(item.path, seen);
    decode(item);
  }
  const database = decode(archive.database);
  if (!database.subarray(0, 16).equals(Buffer.from('SQLite format 3\0'))) throw new Error('迁移包数据库格式无效。');
  return archive;
}

export function inspectBackup(file: string) {
  const archive = readArchive(path.resolve(file));
  return { format: archive.format, appVersion: archive.appVersion, schemaVersion: archive.schemaVersion,
    createdAt: archive.createdAt, counts: archive.counts, exportedFiles: archive.files.length,
    sha256: digest(fs.readFileSync(file)) };
}

/** VACUUM INTO produces a consistent snapshot, including concurrent committed
 * changes, without copying a live SQLite file or its transient journal. */
export function exportBackup(dataDir: string, outFile: string) {
  const source = resolvePaths(path.resolve(dataDir));
  const output = path.resolve(outFile);
  if (fs.existsSync(output)) throw new Error('输出文件已存在，请使用新的文件名。');
  if (!fs.existsSync(source.dbFile)) throw new Error('找不到知识库，请先初始化或指定正确的数据目录。');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cloonex-backup-'));
  try {
    const snapshot = path.join(temporary, 'cloonex.sqlite');
    const db = new Db(source.dbFile, { readOnly: true, fileMustExist: true });
    try { db.run('VACUUM INTO ?', [snapshot]); } finally { db.close(); }
    const info = validateDatabase(snapshot);
    const files: Archive['files'] = [];
    const walk = (directory: string, prefix: string) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const target = path.join(directory, entry.name);
        const relative = `${prefix}/${entry.name}`;
        if (entry.isSymbolicLink()) throw new Error('导出文档目录包含链接，请先移出链接后再打包。');
        if (entry.isDirectory()) walk(target, relative);
        else if (entry.isFile()) files.push(encode(target, relative));
      }
    };
    if (fs.existsSync(source.exportDir)) {
      if (fs.lstatSync(source.exportDir).isSymbolicLink()) throw new Error('导出目录不能是链接。');
      walk(source.exportDir, 'exports');
    }
    const archive: Archive = { format: 'cloonex-backup', formatVersion: 1, appVersion: VERSION,
      schemaVersion: info.schemaVersion, createdAt: new Date().toISOString(), counts: info.counts,
      database: encode(snapshot, 'cloonex.sqlite'), files };
    archiveSchema.parse(archive);
    const seen = new Set<string>();
    for (const file of files) checkExportPath(file.path, seen);
    const serialized = Buffer.from(JSON.stringify(archive));
    const compressed = gzipSync(serialized);
    if (compressed.length > 256 * 1024 * 1024 || serialized.length > 512 * 1024 * 1024) {
      throw new Error('知识库超出迁移包大小上限，请先整理导出文档（压缩256MB/解压512MB）。');
    }
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, compressed, { flag: 'wx', mode: 0o600 });
    return { file: output, bytes: compressed.length, sha256: digest(compressed), counts: info.counts, exportedFiles: files.length };
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

/** Restore only into a fresh destination; never overwrite or merge an existing
 * knowledge base. Validation/migrations happen in staging before publication. */
export function importBackup(archiveFile: string, dataDir: string) {
  const archive = readArchive(path.resolve(archiveFile));
  const target = resolvePaths(path.resolve(dataDir));
  const assertFresh = () => {
    if (fs.existsSync(target.dbFile) || fs.existsSync(target.exportDir)) {
      throw new Error('目标目录已有知识库或导出文档。请指定新的数据目录；导入不会覆盖或合并原有历史。');
    }
    if (fs.existsSync(target.dataDir) && fs.lstatSync(target.dataDir).isSymbolicLink()) throw new Error('目标数据目录不能是链接。');
  };
  assertFresh();
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cloonex-restore-'));
  const staged = path.join(temporary, 'cloonex.sqlite');
  let publishedDb = false;
  let publishedExports = false;
  let lock: number | undefined;
  try {
    fs.writeFileSync(staged, decode(archive.database));
    const before = validateDatabase(staged);
    if (before.schemaVersion !== archive.schemaVersion || Object.keys(before.counts).some((table) => before.counts[table] !== archive.counts[table])) {
      throw new Error('迁移包清单与数据库内容不一致。');
    }
    const upgraded = openDb({ dataDir: temporary });
    const after = counts(upgraded);
    upgraded.close();
    if (Object.keys(before.counts).some((table) => before.counts[table] !== after[table])) throw new Error('数据库升级前后记录数量不一致。');
    fs.mkdirSync(target.dataDir, { recursive: true });
    const lockFile = path.join(target.dataDir, '.cloonex-import.lock');
    lock = fs.openSync(lockFile, 'wx');
    assertFresh();
    // COPYFILE_EXCL prevents a race from replacing a newly created database.
    fs.copyFileSync(staged, target.dbFile, fs.constants.COPYFILE_EXCL);
    publishedDb = true;
    fs.mkdirSync(target.exportDir);
    publishedExports = true;
    for (const item of archive.files) {
      const file = path.join(target.dataDir, ...item.path.split('/'));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, decode(item), { flag: 'wx' });
    }
    return { dataDir: target.dataDir, counts: after, schemaVersion: DATABASE_VERSION,
      exportedFiles: archive.files.length, note: '历史已导入。项目源码需另行迁移；路径变化时使用 project-move。' };
  } catch (error) {
    if (publishedExports) fs.rmSync(target.exportDir, { recursive: true, force: true });
    if (publishedDb) fs.unlinkSync(target.dbFile);
    throw error;
  } finally {
    if (lock !== undefined) { fs.closeSync(lock); fs.unlinkSync(path.join(target.dataDir, '.cloonex-import.lock')); }
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}
