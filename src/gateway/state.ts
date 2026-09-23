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
  }, {
    version: 3,
    sql: `
      CREATE TABLE IF NOT EXISTS gateway_outbound_intents (
        id TEXT PRIMARY KEY, invocation_id TEXT NOT NULL UNIQUE, target_json TEXT NOT NULL,
        message_json TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
        result_json TEXT, last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_gateway_outbound_status ON gateway_outbound_intents(status, created_at);
    `,
  }, {
    version: 4,
    sql: `
      CREATE TABLE IF NOT EXISTS gateway_artifacts (
        id TEXT PRIMARY KEY, canonical_path TEXT NOT NULL, filename TEXT NOT NULL,
        mime TEXT, size INTEGER NOT NULL, conversation_id TEXT NOT NULL, requester_id TEXT NOT NULL,
        status TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_gateway_artifacts_status ON gateway_artifacts(status, expires_at);
    `,
  }, {
    version: 5,
    sql: `
      ALTER TABLE gateway_artifacts ADD COLUMN retention_class TEXT NOT NULL DEFAULT 'task-lifetime';
      ALTER TABLE gateway_artifacts ADD COLUMN owner_invocation_id TEXT;
      ALTER TABLE gateway_artifacts ADD COLUMN owner_plugin_id TEXT;
    `,
  }, {
    version: 6,
    sql: `
      CREATE TABLE IF NOT EXISTS authorization_audit_events (
        id TEXT PRIMARY KEY, operation TEXT NOT NULL, decision TEXT NOT NULL,
        reason TEXT, resource TEXT, requester_id TEXT, task_id TEXT,
        conversation_id TEXT, metadata_json TEXT, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_gateway_authorization_audit_created ON authorization_audit_events(created_at);
    `,
  }];

export class GatewayState {
  readonly store: SqliteStore;
  constructor(filePath: string) {
    this.store = new SqliteStore(filePath);
    migrate(this.store, gatewayMigrations);
    // SENT is an in-flight lease. ACK deletion is the only terminal transition,
    // so every unacknowledged lease must be replayed after a gateway restart.
    this.store.run("UPDATE controller_outbox SET status='PENDING',last_error=COALESCE(last_error,'CONTROLLER_RESTART'),updated_at=? WHERE status='SENT'", nowIso());
    this.store.run("UPDATE command_invocations SET status='INTERRUPTED', updated_at=? WHERE status='RUNNING'", nowIso());
  }

  close(): void { this.store.close(); }

  cleanupOperationalState(now = Date.now()): number {
    const recentCutoff = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
    const auditCutoff = new Date(now - 90 * 24 * 60 * 60 * 1000).toISOString();
    let removed = 0;
    removed += this.store.run("DELETE FROM recent_interactions WHERE created_at<?", recentCutoff).changes;
    removed += this.store.run("DELETE FROM command_invocations WHERE status IN ('COMPLETED','FAILED','INTERRUPTED') AND updated_at<?", recentCutoff).changes;
    removed += this.store.run("DELETE FROM gateway_outbound_intents WHERE status IN ('SENT','FAILED') AND updated_at<?", recentCutoff).changes;
    removed += this.store.run("DELETE FROM authorization_audit_events WHERE created_at<?", auditCutoff).changes;
    return removed;
  }
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
