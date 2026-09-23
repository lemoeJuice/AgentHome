import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type SqlValue = string | number | bigint | Uint8Array | null;

export class SqliteStore {
  readonly db: DatabaseSync;
  readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
  }

  exec(sql: string): void { this.db.exec(sql); }

  run(sql: string, ...params: SqlValue[]): { changes: number; lastInsertRowid: number | bigint } {
    const result = this.db.prepare(sql).run(...params);
    return { changes: Number(result.changes), lastInsertRowid: result.lastInsertRowid };
  }

  get<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, ...params: SqlValue[]): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  all<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, ...params: SqlValue[]): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  checkpoint(): void { this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); }

  close(): void { this.db.close(); }
}

export function migrate(store: SqliteStore, migrations: Array<{ version: number; sql: string }>): void {
  store.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  const current = Number(store.get<{ version: number }>("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations")?.version ?? 0);
  for (const migration of migrations.filter((item) => item.version > current).sort((a, b) => a.version - b.version)) {
    store.transaction(() => {
      store.exec(migration.sql);
      store.run("INSERT INTO schema_migrations(version, applied_at) VALUES (?, datetime('now'))", migration.version);
    });
  }
}
