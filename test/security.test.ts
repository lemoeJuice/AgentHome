import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore, migrate } from "../src/db.js";
import { runtimeMigrations } from "../src/schema.js";
import { MemoryService } from "../src/runtime/memory.js";
import { authorizeMemory, attenuateTask, attenuateWorker, CapabilityRequestDeniedError, deriveCapabilities } from "../src/auth.js";
import { messageKey, namespaceKey } from "../src/shared/ids.js";
import { NOT_IMPLEMENTED } from "../src/shared/types.js";

test("message references keep platform/account/conversation namespaces", () => {
  const qq = messageKey({ platform: "qq", accountId: "a", platformConversationId: "1", threadId: NOT_IMPLEMENTED, messageId: "9" });
  const telegram = messageKey({ platform: "telegram", accountId: "a", platformConversationId: "1", threadId: null, messageId: "9" });
  assert.notEqual(qq, telegram);
  assert.equal(namespaceKey(["qq", "a", "1", null]), "qq\u001fa\u001f1\u001f<null>");
});

test("missing Owner configuration never grants Owner capabilities", () => {
  const capabilities = deriveCapabilities(
    { platform: "qq", accountId: "default", userId: "anyone", trust: "GUEST", conversationId: "private" },
    { platform: "qq", accountId: "default", kind: "private", platformConversationId: "anyone", threadId: null },
    undefined,
    "private",
  );
  assert.equal(capabilities.tasks.canCreate, false);
  assert.equal(capabilities.tasks.canCancel, false);
  assert.equal(capabilities.projects.length, 0);
  assert.equal(capabilities.memory.allowedScopes.includes("owner_private"), false);
});

test("memory service enforces scope at the service boundary", () => {
  const db = new SqliteStore(":memory:");
  migrate(db, runtimeMigrations);
  const memory = new MemoryService(db);
  assert.throws(() => memory.remember({ access: { requesterId: "owner", trust: "OWNER", allowedScopes: ["owner_private"] }, scope: "owner_private", content: "private secret" }), /MEMORY_SCOPE_DENIED/);
  assert.deepEqual(memory.retrieve({ text: "secret", access: { requesterId: "guest", trust: "GUEST", allowedScopes: ["owner_private"] } }).items, []);
  assert.equal(authorizeMemory({ memory: { allowedScopes: ["global_agent"] }, projects: [], qq: { readConversations: [], sendConversations: [] }, plugins: { allowedActions: [] }, artifacts: { readableArtifactAuthorities: [], publishTaskIds: [], allowedDestinations: [] }, tasks: { canCreate: false, visibleTaskIds: [], canCancel: false, canFollowUp: false } }, "owner_private").allowed, false);
  db.close();
});

test("configured MemoryService rejects forged owner scope and accepts canonical owner private scope", () => {
  const db = new SqliteStore(":memory:");
  migrate(db, runtimeMigrations);
  db.run("INSERT INTO conversations(conversation_id,platform,account_id,kind,platform_conversation_id,thread_id_json,trust,memory_scopes_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)", "group-conv", "qq", "a", "group", "g", "null", "GUEST", JSON.stringify(["global_agent", "group:group-conv"]), new Date().toISOString(), new Date().toISOString());
  db.run("INSERT INTO conversations(conversation_id,platform,account_id,kind,platform_conversation_id,thread_id_json,trust,memory_scopes_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)", "private-conv", "qq", "a", "private", "owner", "null", "OWNER", JSON.stringify(["global_agent", "user:owner", "owner_private"]), new Date().toISOString(), new Date().toISOString());
  const memory = new MemoryService(db, { platform: "qq", accountId: "a", userId: "owner" });
  assert.throws(() => memory.remember({ access: { requesterId: "guest", trust: "GUEST", allowedScopes: ["owner_private"], conversationId: "group-conv" }, scope: "owner_private", content: "forged" }), /MEMORY_SCOPE_DENIED/);
  assert.equal(memory.remember({ access: { requesterId: "owner", trust: "OWNER", allowedScopes: ["owner_private"], conversationId: "private-conv" }, scope: "owner_private", content: "canonical" }).content, "canonical");
  db.close();
});

test("capability attenuation rejects out-of-range requests with structured decisions", () => {
  const parent = { memory: { allowedScopes: ["global_agent"] as const }, projects: [{ projectId: "p", access: "READ" as const }], qq: { readConversations: ["c"], sendConversations: ["c"] }, plugins: { allowedActions: [] }, artifacts: { readableArtifactAuthorities: ["agent-home"], publishTaskIds: [], allowedDestinations: ["c"] }, tasks: { canCreate: true, visibleTaskIds: [], canCancel: true, canFollowUp: true } };
  assert.throws(
    () => attenuateTask(parent, { projects: [{ projectId: "other", access: "WRITE" }], memory: { allowedScopes: ["owner_private"] } }, "t"),
    (error: unknown) => error instanceof CapabilityRequestDeniedError
      && error.decision.reason === "PRIVILEGE_ESCALATION_DENIED"
      && error.decision.operation === "task.create"
      && error.decision.resource === "projects",
  );
  const task = attenuateTask(parent, {}, "t");
  assert.deepEqual(task.artifacts.publishTaskIds, []);
  const publishingParent = { ...parent, artifacts: { ...parent.artifacts, publishTaskIds: ["*"] } };
  const publishingTask = attenuateTask(publishingParent, {}, "t");
  assert.deepEqual(publishingTask.artifacts.publishTaskIds, ["t"]);
  assert.throws(
    () => attenuateWorker(task, { projects: [{ projectId: "other", access: "WRITE" }] }),
    (error: unknown) => error instanceof CapabilityRequestDeniedError
      && error.decision.reason === "PRIVILEGE_ESCALATION_DENIED"
      && error.decision.operation === "worker.create"
      && error.decision.resource === "projects",
  );
  assert.throws(
    () => attenuateTask({ ...parent, tasks: { ...parent.tasks, canCreate: false } }, {}, "blocked"),
    (error: unknown) => error instanceof CapabilityRequestDeniedError
      && error.decision.resource === "tasks.canCreate",
  );
});

test("derived private conversation scopes do not fall back to a group scope", () => {
  const conversation = { platform: "qq", accountId: "a", kind: "private" as const, platformConversationId: "guest", threadId: null };
  const guest = deriveCapabilities({ platform: "qq", accountId: "a", userId: "guest", trust: "GUEST", conversationId: "conv" }, conversation, { platform: "qq", accountId: "a", userId: "owner" }, "conv");
  const owner = deriveCapabilities({ platform: "qq", accountId: "a", userId: "owner", trust: "OWNER", conversationId: "conv" }, conversation, { platform: "qq", accountId: "a", userId: "owner" }, "conv");
  assert.deepEqual(guest.memory.allowedScopes, ["global_agent", "user:guest"]);
  assert.ok(owner.memory.allowedScopes.includes("owner_private"));
  assert.ok(!guest.memory.allowedScopes.some((scope) => scope.startsWith("group:")));
});

test("private Memory scope follows explicit Principal identity", () => {
  const conversation = { platform: "qq", accountId: "a", kind: "private" as const, platformConversationId: "qq-user", threadId: null };
  const owner = { platform: "qq", accountId: "a", userId: "owner" };
  const first = deriveCapabilities({ platform: "qq", accountId: "a", userId: "qq-user", principalId: "principal:shared", trust: "GUEST", conversationId: "conv-1" }, conversation, owner, "conv-1");
  const second = deriveCapabilities({ platform: "telegram", accountId: "b", userId: "tg-user", principalId: "principal:shared", trust: "GUEST", conversationId: "conv-2" }, { ...conversation, platform: "telegram", accountId: "b", platformConversationId: "tg-user" }, owner, "conv-2");
  const unbound = deriveCapabilities({ platform: "telegram", accountId: "b", userId: "tg-user", trust: "GUEST", conversationId: "conv-3" }, { ...conversation, platform: "telegram", accountId: "b", platformConversationId: "tg-user" }, owner, "conv-3");
  assert.deepEqual(first.memory.allowedScopes, ["global_agent", "user:principal:shared"]);
  assert.deepEqual(second.memory.allowedScopes, ["global_agent", "user:principal:shared"]);
  assert.deepEqual(unbound.memory.allowedScopes, ["global_agent", "user:tg-user"]);
});

test("MemoryService shares explicitly bound user scope but isolates unbound identity", () => {
  const db = new SqliteStore(":memory:");
  migrate(db, runtimeMigrations);
  const memory = new MemoryService(db);
  const shared = { trust: "GUEST" as const, allowedScopes: ["user:principal:shared"] as const };
  memory.remember({ access: { ...shared, requesterId: "qq-user", principalId: "principal:shared" }, scope: "user:principal:shared", content: "shared preference" });
  assert.equal(memory.retrieve({ text: "shared", access: { ...shared, requesterId: "tg-user", principalId: "principal:shared" } }).items.length, 1);
  assert.equal(memory.retrieve({ text: "shared", access: { requesterId: "tg-user", trust: "GUEST", allowedScopes: ["user:tg-user"] } }).items.length, 0);
  db.close();
});

test("Principal-scoped Memory survives reopening the canonical database", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-home-principal-memory-"));
  const databasePath = join(root, "memory.sqlite");
  const access = { requesterId: "qq-user", principalId: "principal:shared", trust: "GUEST" as const, allowedScopes: ["user:principal:shared"] as const };
  const firstDb = new SqliteStore(databasePath);
  migrate(firstDb, runtimeMigrations);
  new MemoryService(firstDb).remember({ access, scope: "user:principal:shared", content: "persistent preference" });
  firstDb.close();
  const secondDb = new SqliteStore(databasePath);
  migrate(secondDb, runtimeMigrations);
  const memory = new MemoryService(secondDb);
  assert.equal(memory.retrieve({ text: "persistent", access: { ...access, requesterId: "tg-user" } }).items.length, 1);
  assert.equal(memory.retrieve({ text: "persistent", access: { requesterId: "tg-user", trust: "GUEST", allowedScopes: ["user:tg-user"] } }).items.length, 0);
  secondDb.close();
  await rm(root, { recursive: true, force: true });
});

test("Owner group identity does not grant unrestricted project write", () => {
  const group = { platform: "qq", accountId: "a", kind: "group" as const, platformConversationId: "g", threadId: null };
  const owner = deriveCapabilities({ platform: "qq", accountId: "a", userId: "owner", trust: "OWNER", conversationId: "group-conv" }, group, { platform: "qq", accountId: "a", userId: "owner" }, "group-conv");
  const privateOwner = deriveCapabilities({ platform: "qq", accountId: "a", userId: "owner", trust: "OWNER", conversationId: "private-conv" }, { ...group, kind: "private", platformConversationId: "owner" }, { platform: "qq", accountId: "a", userId: "owner" }, "private-conv");
  assert.deepEqual(owner.projects, []);
  assert.equal(owner.tasks.canCreate, false);
  assert.deepEqual(privateOwner.projects, [{ projectId: "*", access: "WRITE" }]);
  assert.equal(privateOwner.tasks.canCreate, true);
});

test("memory facts preserve temporal supersession and portable export", () => {
  const firstDb = new SqliteStore(":memory:"); migrate(firstDb, runtimeMigrations);
  const first = new MemoryService(firstDb);
  const access = { requesterId: "owner", trust: "OWNER" as const, allowedScopes: ["global_agent"] as const };
  const oldFact = first.rememberFact({ access, scope: "global_agent", subject: "user", predicate: "language", object: "en", confidence: 0.8, validFrom: "2026-01-01T00:00:00.000Z", provenance: ["source-old"] });
  const newFact = first.rememberFact({ access, scope: "global_agent", subject: "user", predicate: "language", object: "zh-CN", confidence: 0.99, validFrom: "2026-02-01T00:00:00.000Z", provenance: ["source-new"] });
  assert.equal(firstDb.get<{ status: string; valid_to: string }>("SELECT status,valid_to FROM memory_facts WHERE id=?", oldFact.id)?.status, "superseded");
  assert.equal(first.getMemory(newFact.id, access)?.type, "fact");
  const exported = first.exportMemory(access);
  const secondDb = new SqliteStore(":memory:"); migrate(secondDb, runtimeMigrations);
  const imported = new MemoryService(secondDb).importMemory(exported);
  assert.ok(imported.imported >= 2);
  const portable = first.exportMemoryJsonl(access);
  const portableDb = new SqliteStore(":memory:"); migrate(portableDb, runtimeMigrations);
  const portableImported = new MemoryService(portableDb).importMemoryJsonl(portable);
  assert.deepEqual(portableImported.counts, portable.manifest.counts);
  assert.equal(portableDb.get<{ count: number }>("SELECT count(*) AS count FROM memory_facts WHERE status='active'")?.count, 1);
  assert.deepEqual(JSON.parse(portableDb.get<{ provenance_json: string }>("SELECT provenance_json FROM memory_facts WHERE id=?", newFact.id)!.provenance_json), ["source-new"]);
  assert.ok((portableDb.get<{ count: number }>("SELECT count(*) AS count FROM memory_profiles")?.count ?? 0) > 0);
  assert.throws(() => new MemoryService(portableDb).importMemoryJsonl({ ...portable, facts: `${portable.facts}{}\n` }), /MEMORY_IMPORT_CHECKSUM_INVALID:facts/);
  firstDb.close(); secondDb.close(); portableDb.close();
});

test("Memory hide is non-destructive but removes the record from reads and rejects malformed imports", () => {
  const db = new SqliteStore(":memory:"); migrate(db, runtimeMigrations);
  const memory = new MemoryService(db);
  const access = { requesterId: "owner", trust: "OWNER" as const, allowedScopes: ["global_agent"] as const };
  const record = memory.remember({ access, scope: "global_agent", content: "temporary context" });
  assert.equal(memory.forget({ id: record.id, access, mode: "hide" }).mode, "hide");
  assert.equal(memory.getMemory(record.id, access), null);
  assert.ok(db.get("SELECT 1 FROM memory_explicit WHERE id=?", record.id));
  assert.equal(memory.retrieve({ text: "temporary", access }).items.length, 0);
  assert.throws(() => memory.importMemory({ manifest: { format: "agent-memory", version: 1, exportedAt: new Date().toISOString(), counts: { episodes: 0, facts: 1, episodic: 0, explicit: 0, profile: 0 } }, episodes: [], facts: [{ id: "fact-bad", scope: "global_agent", subject: "x", predicate: "y", object: true, confidence: 2, status: "active", provenance: [] }], episodic: [], explicit: [], profile: [] }, access), /MEMORY_IMPORT_FACT_INVALID/);
  db.close();
});

test("memory episodes consolidate into provenance-linked facts, episodic records, FTS, and profiles", () => {
  const db = new SqliteStore(":memory:"); migrate(db, runtimeMigrations);
  const memory = new MemoryService(db);
  const access = { requesterId: "owner", trust: "OWNER" as const, allowedScopes: ["global_agent"] as const };
  const episode = memory.ingestEpisode({
    access,
    episode: {
      scope: "global_agent",
      source: { type: "chat.message", platform: "qq", sourceId: "evt-1" },
      actor: { type: "user", id: "owner" },
      content: "The deployment uses staging.",
      occurredAt: "2026-09-20T00:00:00.000Z",
      trust: "owner",
      metadata: { facts: [{ subject: "deployment", predicate: "environment", object: "staging", confidence: 0.9 }], episodic: [{ situation: "deployment discussion", lesson: "use staging" }] },
    },
  });
  assert.deepEqual(memory.consolidate(), { processed: 1, failed: 0 });
  assert.equal(db.get<{ status: string }>("SELECT status FROM memory_inbox WHERE episode_id=?", episode.id)?.status, "done");
  assert.equal(db.get<{ count: number }>("SELECT count(*) AS count FROM memory_facts WHERE status='active'")?.count, 1);
  assert.equal(db.get<{ count: number }>("SELECT count(*) AS count FROM memory_episodic")?.count, 1);
  assert.ok(db.get("SELECT 1 FROM memory_facts WHERE provenance_json LIKE ?", `%${episode.id}%`));
  assert.ok(db.get("SELECT 1 FROM memory_fts WHERE record_type='episodic'"));
  assert.ok(db.get("SELECT 1 FROM memory_profiles WHERE scope='global_agent'"));
  const result = memory.retrieve({ text: "staging", access, types: ["fact", "episodic"] });
  assert.equal(result.items.length, 2);
  assert.equal(memory.retrieve({ text: "staging deployment", access, types: ["fact"] }).items.length, 1);
  const episodic = result.items.find((item) => item.type === "episodic");
  assert.equal(memory.getMemory(episodic!.id, access)?.type, "episodic");
  assert.deepEqual(memory.forget({ id: episodic!.id, access, purge: true }), { deleted: true });
  assert.equal(memory.getMemory(episodic!.id, access), null);
  assert.throws(() => memory.ingestEpisode({ access: { requesterId: "guest", trust: "GUEST", allowedScopes: ["global_agent"] }, episode: { scope: "owner_private", source: { type: "chat.message" }, content: "private", occurredAt: new Date().toISOString(), trust: "guest" } }), /MEMORY_SCOPE_DENIED/);
  const exported = memory.exportMemory(access);
  const importedDb = new SqliteStore(":memory:"); migrate(importedDb, runtimeMigrations);
  const imported = new MemoryService(importedDb).importMemory(exported, access);
  assert.ok(imported.imported > 0);
  assert.ok(importedDb.get("SELECT 1 FROM memory_inbox WHERE status='pending'"));
  importedDb.close(); db.close();
});

test("memory inbox and derived index recover without blocking canonical ingest", () => {
  const db = new SqliteStore(":memory:"); migrate(db, runtimeMigrations);
  const memory = new MemoryService(db);
  const access = { requesterId: "owner", trust: "OWNER" as const, allowedScopes: ["global_agent"] as const };
  const episode = memory.ingestEpisode({ access, episode: { scope: "global_agent", source: { type: "test" }, content: "queued episode", occurredAt: new Date().toISOString(), trust: "owner" } });
  assert.equal(db.get<{ status: string }>("SELECT status FROM memory_inbox WHERE episode_id=?", episode.id)?.status, "pending");
  assert.equal(db.get("SELECT 1 FROM memory_fts WHERE record_id=?", episode.id), undefined);
  assert.ok(db.get("SELECT 1 FROM memory_index_queue WHERE record_id=? AND status='pending'", episode.id));
  db.run("UPDATE memory_inbox SET status='processing' WHERE episode_id=?", episode.id);
  db.run("UPDATE memory_index_queue SET status='processing' WHERE record_id=?", episode.id);
  memory.recover();
  assert.equal(db.get<{ status: string }>("SELECT status FROM memory_inbox WHERE episode_id=?", episode.id)?.status, "pending");
  assert.equal(db.get<{ status: string }>("SELECT status FROM memory_index_queue WHERE record_id=?", episode.id)?.status, "pending");
  assert.deepEqual(memory.consolidate(), { processed: 1, failed: 0 });
  assert.ok(db.get("SELECT 1 FROM memory_fts WHERE record_id=?", episode.id));
  db.run("UPDATE memory_inbox SET status='failed',retries=5,next_attempt_at=? WHERE episode_id=?", new Date(0).toISOString(), episode.id);
  assert.deepEqual(memory.consolidate(), { processed: 0, failed: 0 });
  assert.equal(db.get<{ status: string }>("SELECT status FROM memory_inbox WHERE episode_id=?", episode.id)?.status, "failed");
  db.close();
});

test("memory episode adapters preserve source types and task-event idempotency", () => {
  const db = new SqliteStore(":memory:"); migrate(db, runtimeMigrations);
  const memory = new MemoryService(db);
  const owner = { requesterId: "owner", trust: "OWNER" as const, allowedScopes: ["global_agent"] as const };
  const task = memory.ingestTaskEpisode({ access: owner, scope: "global_agent", taskId: "task-1", sourceId: "task-event-1", content: "task completed", occurredAt: new Date().toISOString() });
  const duplicate = memory.ingestTaskEpisode({ access: owner, scope: "global_agent", taskId: "task-1", sourceId: "task-event-1", content: "different retry text", occurredAt: new Date().toISOString() });
  assert.equal(duplicate.id, task.id);
  assert.equal(db.get<{ count: number }>("SELECT count(*) AS count FROM memory_episodes WHERE source_json LIKE '%task-event-1%'")?.count, 1);
  const document = memory.ingestDocumentEpisode({ access: owner, scope: "global_agent", documentId: "doc-1", content: "document content", occurredAt: new Date().toISOString() });
  const manual = memory.ingestManualEpisode({ access: owner, scope: "global_agent", sourceId: "manual-1", content: "manual note", occurredAt: new Date().toISOString() });
  const system = memory.ingestSystemEpisode({ access: { requesterId: "system", trust: "OWNER", allowedScopes: ["global_agent"] }, scope: "global_agent", sourceId: "system-1", content: "system event", occurredAt: new Date().toISOString() });
  assert.deepEqual([task, document, manual, system].map((episode) => episode.source.type), ["task", "document", "manual", "system_event"]);
  assert.throws(() => memory.ingestSystemEpisode({ access: owner, scope: "global_agent", sourceId: "forged", content: "forged", occurredAt: new Date().toISOString() }), /MEMORY_SYSTEM_INGEST_DENIED/);
  db.close();
});
