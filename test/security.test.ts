import test from "node:test";
import assert from "node:assert/strict";
import { SqliteStore, migrate } from "../src/db.js";
import { runtimeMigrations } from "../src/schema.js";
import { MemoryService } from "../src/runtime/memory.js";
import { authorizeMemory, attenuateTask, attenuateWorker, deriveCapabilities } from "../src/auth.js";
import { messageKey, namespaceKey } from "../src/shared/ids.js";
import { NOT_IMPLEMENTED } from "../src/shared/types.js";

test("message references keep platform/account/conversation namespaces", () => {
  const qq = messageKey({ platform: "qq", accountId: "a", platformConversationId: "1", threadId: NOT_IMPLEMENTED, messageId: "9" });
  const telegram = messageKey({ platform: "telegram", accountId: "a", platformConversationId: "1", threadId: null, messageId: "9" });
  assert.notEqual(qq, telegram);
  assert.equal(namespaceKey(["qq", "a", "1", null]), "qq\u001fa\u001f1\u001f<null>");
});

test("memory service enforces scope at the service boundary", () => {
  const db = new SqliteStore(":memory:");
  migrate(db, runtimeMigrations);
  const memory = new MemoryService(db);
  memory.remember({ access: { requesterId: "owner", trust: "OWNER", allowedScopes: ["owner_private"] }, scope: "owner_private", content: "private secret" });
  assert.deepEqual(memory.retrieve({ text: "secret", access: { requesterId: "guest", trust: "GUEST", allowedScopes: ["owner_private"] } }).items, []);
  assert.equal(authorizeMemory({ memory: { allowedScopes: ["global_agent"] }, projects: [], qq: { readConversations: [], sendConversations: [] }, plugins: { allowedActions: [] }, artifacts: { publishTaskIds: [], allowedDestinations: [] }, tasks: { canCreate: false, visibleTaskIds: [], canCancel: false, canFollowUp: false } }, "owner_private").allowed, false);
  db.close();
});

test("capability attenuation cannot expand a parent", () => {
  const parent = { memory: { allowedScopes: ["global_agent"] as const }, projects: [{ projectId: "p", access: "READ" as const }], qq: { readConversations: ["c"], sendConversations: ["c"] }, plugins: { allowedActions: [] }, artifacts: { publishTaskIds: [], allowedDestinations: ["c"] }, tasks: { canCreate: true, visibleTaskIds: [], canCancel: true, canFollowUp: true } };
  const task = attenuateTask(parent, { projects: [{ projectId: "other", access: "WRITE" }], memory: { allowedScopes: ["owner_private"] } }, "t");
  const worker = attenuateWorker(task, { projects: [{ projectId: "other", access: "WRITE" }], memory: { allowedScopes: ["owner_private"] } });
  assert.deepEqual(task.projects, []);
  assert.deepEqual(task.memory.allowedScopes, []);
  assert.deepEqual(worker.projects, []);
  assert.deepEqual(worker.memory.allowedScopes, []);
});

test("derived private conversation scopes do not fall back to a group scope", () => {
  const conversation = { platform: "qq", accountId: "a", kind: "private" as const, platformConversationId: "guest", threadId: null };
  const guest = deriveCapabilities({ platform: "qq", accountId: "a", userId: "guest", trust: "GUEST", conversationId: "conv" }, conversation, { platform: "qq", accountId: "a", userId: "owner" }, "conv");
  const owner = deriveCapabilities({ platform: "qq", accountId: "a", userId: "owner", trust: "OWNER", conversationId: "conv" }, conversation, { platform: "qq", accountId: "a", userId: "owner" }, "conv");
  assert.deepEqual(guest.memory.allowedScopes, ["global_agent", "user:guest"]);
  assert.ok(owner.memory.allowedScopes.includes("owner_private"));
  assert.ok(!guest.memory.allowedScopes.some((scope) => scope.startsWith("group:")));
});

test("memory facts preserve temporal supersession and portable export", () => {
  const firstDb = new SqliteStore(":memory:"); migrate(firstDb, runtimeMigrations);
  const first = new MemoryService(firstDb);
  const access = { requesterId: "owner", trust: "OWNER" as const, allowedScopes: ["global_agent"] as const };
  const oldFact = first.rememberFact({ access, scope: "global_agent", subject: "user", predicate: "language", object: "en", confidence: 0.8, validFrom: "2026-01-01T00:00:00.000Z" });
  const newFact = first.rememberFact({ access, scope: "global_agent", subject: "user", predicate: "language", object: "zh-CN", confidence: 0.99, validFrom: "2026-02-01T00:00:00.000Z" });
  assert.equal(firstDb.get<{ status: string; valid_to: string }>("SELECT status,valid_to FROM memory_facts WHERE id=?", oldFact.id)?.status, "superseded");
  assert.equal(first.getMemory(newFact.id, access)?.type, "fact");
  const exported = first.exportMemory(access);
  const secondDb = new SqliteStore(":memory:"); migrate(secondDb, runtimeMigrations);
  const imported = new MemoryService(secondDb).importMemory(exported);
  assert.ok(imported.imported >= 2);
  firstDb.close(); secondDb.close();
});
