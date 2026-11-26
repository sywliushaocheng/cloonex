import pkg from 'node-sqlite3-wasm';

const { Database } = pkg as unknown as {
  Database: new (filename?: string, options?: { fileMustExist?: boolean; readOnly?: boolean }) => import('node-sqlite3-wasm').Database;
};

/**
 * Thin wrapper over node-sqlite3-wasm.
 *
 * Why WASM: the native better-sqlite3 prebuilt binary crashed the interpreter
 * on the development machine (0xC0000005), and compiling from source is not
 * viable for an npm package that must install without a toolchain on Windows
 * and macOS. The WASM build ships SQLite 3.53 with FTS5 and needs no compiler.
 *
 * Note: this build reports journal_mode=delete; WAL is unavailable. The MCP
 * server uses a single connection per process, so writes are serialised.
 */
export type SqlPrimitive = string | number | bigint | boolean | null | Uint8Array;
export type Bind = SqlPrimitive[] | Record<string, SqlPrimitive>;
export type Row = Record<string, unknown>;

type DatabaseInstance = InstanceType<typeof Database>;

export class Db {
  readonly raw: DatabaseInstance;
  readonly path: string;
  private closed = false;
  private txDepth = 0;

  constructor(path: string, options: { readOnly?: boolean; fileMustExist?: boolean } = {}) {
    this.path = path;
    this.raw = new Database(path, options);
    this.raw.exec('PRAGMA foreign_keys = ON;');
    this.raw.exec('PRAGMA busy_timeout = 5000;');
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  all(sql: string, bind?: Bind): Row[] {
    return this.raw.all(sql, bind) as unknown as Row[];
  }

  get(sql: string, bind?: Bind): Row | undefined {
    const rows = this.raw.all(sql, bind) as unknown as Row[];
    return rows.length > 0 ? rows[0] : undefined;
  }

  run(sql: string, bind?: Bind): { changes: number; lastInsertRowid: number | bigint } {
    const info = this.raw.run(sql, bind);
    return {
      changes: Number(info.changes ?? 0),
      lastInsertRowid: info.lastInsertRowid ?? 0,
    };
  }

  /**
   * Runs fn inside a transaction; rolls back on any throw.
   *
   * Re-entrant: domain services compose (finalizeTask calls addStatement), and
   * SQLite rejects a second BEGIN. Nested calls therefore use SAVEPOINTs so an
   * inner failure can still roll back without poisoning the outer transaction.
   */
  transaction<T>(fn: () => T): T {
    const depth = this.txDepth;
    const savepoint = `sp_${depth}`;
    if (depth === 0) this.exec('BEGIN');
    else this.exec(`SAVEPOINT ${savepoint}`);
    this.txDepth = depth + 1;

    try {
      const result = fn();
      if (depth === 0) this.exec('COMMIT');
      else this.exec(`RELEASE ${savepoint}`);
      return result;
    } catch (error) {
      try {
        if (depth === 0) this.exec('ROLLBACK');
        else this.exec(`ROLLBACK TO ${savepoint}`);
      } catch {
        // A rollback failure must not mask the original error.
      }
      throw error;
    } finally {
      this.txDepth = depth;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.raw.close();
  }
}
