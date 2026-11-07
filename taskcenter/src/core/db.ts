import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { MIGRATIONS } from "./migrations.js";

export type Row = Record<string, unknown>;
export type Param = SQLInputValue;

/**
 * Thin wrapper around node:sqlite with migrations and transaction helper.
 * All database access in the task center goes through this class so the
 * engine can be swapped (better-sqlite3, libsql) by changing one file.
 */
export class Db {
  readonly raw: DatabaseSync;
  readonly path: string;
  private txDepth = 0;

  constructor(path: string) {
    this.path = path;
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.raw = new DatabaseSync(path);
    this.raw.exec("PRAGMA journal_mode = WAL;");
    this.raw.exec("PRAGMA synchronous = NORMAL;");
    this.raw.exec("PRAGMA foreign_keys = ON;");
    this.raw.exec("PRAGMA busy_timeout = 5000;");
  }

  migrate(): string[] {
    this.raw.exec(
      "CREATE TABLE IF NOT EXISTS migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
    );
    const applied = new Set(
      (this.raw.prepare("SELECT id FROM migrations").all() as Array<{ id: string }>).map((r) => r.id),
    );
    const done: string[] = [];
    for (const m of MIGRATIONS) {
      if (applied.has(m.id)) continue;
      this.transaction(() => {
        this.raw.exec(m.sql);
        this.raw
          .prepare("INSERT INTO migrations (id, applied_at) VALUES (?, ?)")
          .run(m.id, new Date().toISOString());
      });
      done.push(m.id);
    }
    return done;
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  run(sql: string, ...params: Param[]): { changes: number; lastInsertRowid: number | bigint } {
    const r = this.raw.prepare(sql).run(...params);
    return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid };
  }

  get<T = Row>(sql: string, ...params: Param[]): T | undefined {
    return this.raw.prepare(sql).get(...params) as T | undefined;
  }

  all<T = Row>(sql: string, ...params: Param[]): T[] {
    return this.raw.prepare(sql).all(...params) as T[];
  }

  /** Nested-safe transaction (uses SAVEPOINTs for inner calls). */
  transaction<T>(fn: () => T): T {
    const sp = `sp${this.txDepth}`;
    if (this.txDepth === 0) this.raw.exec("BEGIN IMMEDIATE");
    else this.raw.exec(`SAVEPOINT ${sp}`);
    this.txDepth++;
    try {
      const out = fn();
      this.txDepth--;
      if (this.txDepth === 0) this.raw.exec("COMMIT");
      else this.raw.exec(`RELEASE ${sp}`);
      return out;
    } catch (e) {
      this.txDepth--;
      if (this.txDepth === 0) this.raw.exec("ROLLBACK");
      else this.raw.exec(`ROLLBACK TO ${sp}`);
      throw e;
    }
  }

  close(): void {
    try {
      this.raw.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    } catch {
      /* ignore */
    }
    this.raw.close();
  }
}

export function openDb(path: string): Db {
  const db = new Db(path);
  db.migrate();
  return db;
}
