import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Db } from './database.js';
import { SCHEMA_SQL } from './schema.js';
import { DATABASE_VERSION } from '../version.js';

/**
 * Data location rules (product doc §10.2):
 *  - the program lives wherever npm put it;
 *  - personal knowledge lives in a user-chosen directory, separate from the program;
 *  - the location is discoverable, and never silently inside node_modules.
 *
 * Resolution order:
 *   1. CLOONEX_DATA_DIR environment variable
 *   2. dataDir recorded in the config file
 *   3. ~/.cloonex (default)
 */
export const DEFAULT_DATA_DIR = path.join(os.homedir(), '.cloonex');

function configPath(): string {
  const override = process.env.CLOONEX_CONFIG;
  return override && override.trim().length > 0 ? override : path.join(DEFAULT_DATA_DIR, 'config.json');
}

export interface CloonexConfig {
  dataDir?: string;
}

export function readConfig(): CloonexConfig {
  const file = configPath();
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as CloonexConfig;
  } catch {
    return {};
  }
}

export function writeConfig(config: CloonexConfig): string {
  const file = configPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return file;
}

export function resolveDataDir(): string {
  const fromEnv = process.env.CLOONEX_DATA_DIR;
  if (fromEnv && fromEnv.trim().length > 0) return path.resolve(fromEnv.trim());
  const fromConfig = readConfig().dataDir;
  if (fromConfig && fromConfig.trim().length > 0) return path.resolve(fromConfig.trim());
  return DEFAULT_DATA_DIR;
}

export interface Paths {
  dataDir: string;
  dbFile: string;
  exportDir: string;
}

export function resolvePaths(dataDir = resolveDataDir()): Paths {
  return {
    dataDir,
    dbFile: path.join(dataDir, 'cloonex.sqlite'),
    exportDir: path.join(dataDir, 'exports'),
  };
}

export interface OpenOptions {
  dataDir?: string;
  /** Skip creating the directory; used by read-only commands to fail early. */
  mustExist?: boolean;
}

export function openDb(options: OpenOptions = {}): Db {
  const paths = resolvePaths(options.dataDir);
  if (fs.existsSync(path.join(paths.dataDir, '.cloonex-import.lock'))) throw new Error('该数据目录正在导入，请稍后重试。');
  if (options.mustExist && !fs.existsSync(paths.dbFile)) {
    throw new Error(`Cloonex data not found at ${paths.dbFile}. Run "cloonex init" first.`);
  }
  fs.mkdirSync(paths.dataDir, { recursive: true });
  const db = new Db(paths.dbFile);
  try {
    const hasMeta = db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'");
    const oldVersion = hasMeta ? Number(db.get("SELECT value FROM meta WHERE key='schema_version'")?.value ?? 0) : 0;
    if (oldVersion > DATABASE_VERSION) throw new Error('数据库来自更新的 Cloonex 版本，请先升级程序。');
    db.transaction(() => {
      db.exec(SCHEMA_SQL);
      migrate(db);
      db.run(`INSERT OR IGNORE INTO task_feature(task_id,feature_id)
        SELECT t.id,t.feature_id FROM task t JOIN feature f ON f.id=t.feature_id AND f.project_id=t.project_id`);
      if (oldVersion !== DATABASE_VERSION) db.run(
        `INSERT INTO meta (key,value) VALUES ('schema_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
        [String(DATABASE_VERSION)],
      );
    });
    return db;
  } catch (error) { db.close(); throw error; }
}

/**
 * Additive migrations for databases created by an earlier version.
 *
 * CREATE TABLE IF NOT EXISTS never alters an existing table, so new columns
 * must be added explicitly. Only nullable columns are added here, and user data
 * is never rewritten: an existing database must keep working after upgrade.
 */
function migrate(db: Db): void {
  const additions: Array<{ table: string; column: string; definition: string }> = [
    { table: 'task', column: 'stack', definition: 'TEXT' },
    { table: 'task', column: 'scene', definition: 'TEXT' },
    { table: 'feature_statement', column: 'topic_key', definition: 'TEXT' },
    { table: 'project_convention', column: 'relative_path', definition: 'TEXT' },
    { table: 'project_convention', column: 'fingerprint', definition: 'TEXT' },
  ];

  for (const { table, column, definition } of additions) {
    const columns = db.all(`PRAGMA table_info(${table})`).map((row) => String(row.name));
    if (!columns.includes(column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }
}

export function dataDirSize(dataDir: string): { bytes: number; files: number } {
  if (!fs.existsSync(dataDir)) return { bytes: 0, files: 0 };
  let bytes = 0;
  let files = 0;
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        files += 1;
        bytes += fs.statSync(full).size;
      }
    }
  };
  walk(dataDir);
  return { bytes, files };
}

export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}
