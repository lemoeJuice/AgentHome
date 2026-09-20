import type { SqliteStore } from "./db.js";

export const runtimeMigrations = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS runtime_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ingress_events (
        event_id TEXT PRIMARY KEY, event_type TEXT NOT NULL, envelope_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('PENDING','PROCESSING','DONE','FAILED')),
        attempts INTEGER NOT NULL DEFAULT 0, received_at TEXT NOT NULL, updated_at TEXT NOT NULL, error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_ingress_status ON ingress_events(status, received_at);
      CREATE TABLE IF NOT EXISTS principals (
        principal_id TEXT PRIMARY KEY, trust TEXT NOT NULL CHECK(trust IN ('OWNER','GUEST')), created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS platform_identities (
        platform TEXT NOT NULL, account_id TEXT NOT NULL, user_id TEXT NOT NULL,
        principal_id TEXT NOT NULL REFERENCES principals(principal_id),
        PRIMARY KEY(platform, account_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS conversations (
        conversation_id TEXT PRIMARY KEY, platform TEXT NOT NULL, account_id TEXT NOT NULL,
        kind TEXT NOT NULL, platform_conversation_id TEXT NOT NULL, thread_id_json TEXT NOT NULL,
        principal_id TEXT, trust TEXT NOT NULL, memory_scopes_json TEXT NOT NULL,
        main_session_id TEXT, main_session_path TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(platform, account_id, platform_conversation_id, thread_id_json)
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, goal TEXT NOT NULL, status TEXT NOT NULL,
        requester_json TEXT NOT NULL, trust TEXT NOT NULL, origin_conversation_id TEXT NOT NULL,
        notification_conversation_id TEXT NOT NULL, parent_task_id TEXT, capabilities_json TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_conversation ON tasks(origin_conversation_id, notification_conversation_id);
      CREATE TABLE IF NOT EXISTS worker_executions (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), objective TEXT NOT NULL,
        status TEXT NOT NULL, harness TEXT NOT NULL, harness_session_id TEXT, workspace_id TEXT,
        workspace_access TEXT, process_id INTEGER, started_at TEXT, updated_at TEXT NOT NULL, finished_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_workers_task_status ON worker_executions(task_id, status);
      CREATE TABLE IF NOT EXISTS task_events (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL, worker_id TEXT, type TEXT NOT NULL,
        payload_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events(task_id, created_at);
      CREATE TABLE IF NOT EXISTS task_mailbox (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL, type TEXT NOT NULL, source_conversation_id TEXT NOT NULL,
        source_message_key TEXT NOT NULL, content TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL, delivered_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_mailbox_task_status ON task_mailbox(task_id, status);
      CREATE TABLE IF NOT EXISTS pending_questions (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL, worker_id TEXT NOT NULL, question TEXT NOT NULL,
        status TEXT NOT NULL, outgoing_message_key TEXT, answer TEXT, created_at TEXT NOT NULL,
        answered_at TEXT, closed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_questions_task_status ON pending_questions(task_id, status);
      CREATE TABLE IF NOT EXISTS message_bindings (
        id TEXT PRIMARY KEY, platform TEXT NOT NULL, account_id TEXT NOT NULL,
        platform_conversation_id TEXT NOT NULL, thread_id_json TEXT NOT NULL, message_id TEXT NOT NULL,
        binding_type TEXT NOT NULL, binding_id TEXT NOT NULL, created_at TEXT NOT NULL,
        UNIQUE(platform, account_id, platform_conversation_id, thread_id_json, message_id, binding_type, binding_id)
      );
      CREATE INDEX IF NOT EXISTS idx_message_bindings_lookup ON message_bindings(platform, account_id, platform_conversation_id, message_id);
      CREATE TABLE IF NOT EXISTS project_locks (
        project_id TEXT PRIMARY KEY, mode TEXT NOT NULL, owner_worker_id TEXT NOT NULL, acquired_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS owned_processes (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL, worker_id TEXT NOT NULL, pid INTEGER NOT NULL,
        process_group_id INTEGER, command_summary TEXT NOT NULL, started_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runtime_exceptions (
        id TEXT PRIMARY KEY, task_id TEXT, worker_id TEXT, operation TEXT NOT NULL, category TEXT NOT NULL,
        summary TEXT NOT NULL, details_json TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY, owner_task_id TEXT, producer_worker_id TEXT, source_type TEXT NOT NULL,
        canonical_path TEXT NOT NULL, filename TEXT NOT NULL, mime TEXT, size INTEGER NOT NULL,
        sha256 TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_artifacts_task ON artifacts(owner_task_id, status);
      CREATE TABLE IF NOT EXISTS memory_episodes (
        id TEXT PRIMARY KEY, scope TEXT NOT NULL, source_json TEXT NOT NULL, actor_json TEXT,
        content TEXT NOT NULL, occurred_at TEXT NOT NULL, ingested_at TEXT NOT NULL, trust TEXT NOT NULL,
        metadata_json TEXT
      );
      CREATE TABLE IF NOT EXISTS memory_inbox (
        id TEXT PRIMARY KEY, episode_id TEXT NOT NULL REFERENCES memory_episodes(id), status TEXT NOT NULL,
        retries INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memory_facts (
        id TEXT PRIMARY KEY, scope TEXT NOT NULL, subject TEXT NOT NULL, predicate TEXT NOT NULL,
        object_json TEXT NOT NULL, confidence REAL NOT NULL, valid_from TEXT, valid_to TEXT,
        status TEXT NOT NULL, provenance_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memory_facts_scope ON memory_facts(scope, status);
      CREATE TABLE IF NOT EXISTS memory_episodic (
        id TEXT PRIMARY KEY, scope TEXT NOT NULL, situation TEXT NOT NULL, action TEXT, outcome TEXT,
        lesson TEXT, provenance_json TEXT NOT NULL, occurred_at TEXT, importance REAL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memory_explicit (
        id TEXT PRIMARY KEY, scope TEXT NOT NULL, content TEXT NOT NULL, provenance_json TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memory_profiles (
        id TEXT PRIMARY KEY, scope TEXT NOT NULL, label TEXT NOT NULL, content TEXT NOT NULL,
        source_memory_ids_json TEXT NOT NULL, generated_at TEXT NOT NULL, version INTEGER NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(record_id UNINDEXED, record_type UNINDEXED, scope UNINDEXED, content);
    `,
  },
  {
    version: 2,
    sql: `
      ALTER TABLE artifacts ADD COLUMN source_conversation_id TEXT;
      CREATE INDEX IF NOT EXISTS idx_artifacts_conversation ON artifacts(source_conversation_id, status);
    `,
  },
  {
    version: 3,
    sql: `
      ALTER TABLE worker_executions ADD COLUMN capabilities_json TEXT;
    `,
  },
];

export function ensureRuntimeSchema(store: SqliteStore): void {
  // Kept as a named boundary so migrations can be extended without leaking SQL to services.
  void store;
}
