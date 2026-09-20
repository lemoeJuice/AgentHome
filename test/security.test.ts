import test from "node:test";
import assert from "node:assert/strict";
import { SqliteStore, migrate } from "../src/db.js";
import { runtimeMigrations } from "../src/schema.js";
import { MemoryService } from "../src/runtime/memory.js";
import { authorizeMemory, attenuateTask, attenuateWorker } from "../src/auth.js";
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
