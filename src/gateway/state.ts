import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { migrate, SqliteStore } from "../db.js";
import { nowIso } from "../shared/ids.js";
import type { JsonValue } from "../shared/types.js";
import type { PluginStateHandle } from "./registry.js";

export const gatewayMigrations = [{
  version: 1,
  sql: `
    CREATE TABLE IF NOT EXISTS command_invocations (
      id TEXT PRIMARY KEY, command TEXT NOT NULL, plugin_id TEXT NOT NULL, requester_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL, status TEXT NOT NULL, result_json TEXT, context_summary TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_command_invocations_status ON command_invocations(status);
    CREATE TABLE IF NOT EXISTS gateway_message_bindings (
      id TEXT PRIMARY KEY, platform TEXT NOT NULL, account_id TEXT NOT NULL, platform_conversation_id TEXT NOT NULL,
      thread_id_json TEXT NOT NULL, message_id TEXT NOT NULL, invocation_id TEXT NOT NULL, created_at TEXT NOT NULL,
      UNIQUE(platform, account_id, platform_conversation_id, thread_id_json, message_id)
    );
    CREATE TABLE IF NOT EXISTS recent_interactions (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, invocation_id TEXT NOT NULL, summary TEXT NOT NULL,
      result_ref TEXT, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_recent_interactions_conversation ON recent_interactions(conversation_id, created_at);
  `,
}, {
  version: 2,
  sql: `
    CREATE TABLE IF NOT EXISTS controller_outbox (
      event_id TEXT PRIMARY KEY, envelope_json TEXT NOT NULL, status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_controller_outbox_status ON controller_outbox(status, created_at);
  `,
}];

export class GatewayState {
  readonly store: SqliteStore;
  constructor(filePath: string) {
    this.store = new SqliteStore(filePath);
    migrate(this.store, gatewayMigrations);
    this.store.run("UPDATE command_invocations SET status='INTERRUPTED', updated_at=? WHERE status='RUNNING'", nowIso());
  }

  close(): void { this.store.close(); }
}

export class FilePluginState implements PluginStateHandle {
  readonly root: string;
  constructor(root: string) { this.root = root; }

  async readJson<T>(name: string): Promise<T | null> {
    const path = this.safePath(name);
    try { return JSON.parse(await readFile(path, "utf8")) as T; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }

  async writeJson(name: string, value: JsonValue): Promise<void> {
    const path = this.safePath(name);
    await mkdir(this.root, { recursive: true });
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  }

  private safePath(name: string): string {
    if (basename(name) !== name || !name.endsWith(".json")) throw new Error("PLUGIN_STATE_PATH_DENIED");
    return join(this.root, name);
  }
}
