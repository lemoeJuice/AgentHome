import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore, migrate } from "../src/db.js";
import { runtimeMigrations } from "../src/schema.js";
import { OWNER_PRINCIPAL_ID, PrincipalService, PRINCIPAL_UID_MAX, PRINCIPAL_UID_MIN } from "../src/runtime/principals.js";
import { migrateCurrentState } from "../src/runtime/manual-migration.js";
import type { AppConfig } from "../src/config.js";

test("Principal runtime identities are stable, unique and independent of platform IDs", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-home-principal-id-"));
  const dbPath = join(root, "agent.db");
  const db = new SqliteStore(dbPath);
  migrate(db, runtimeMigrations);
  try {
    const service = new PrincipalService(db, root);
    service.ensureOwnerPrincipal();
    const configuredOwners = [{ platform: "qq", accountId: "default", userId: "owner-1" }, { platform: "qq", accountId: "default", userId: "owner-2" }];
    const ownerOne = service.resolveIdentity("qq", "default", "owner-1", configuredOwners);
    const ownerTwo = service.resolveIdentity("qq", "default", "owner-2", configuredOwners);
    assert.equal(ownerOne.principalId, OWNER_PRINCIPAL_ID);
    assert.notEqual(ownerTwo.principalId, OWNER_PRINCIPAL_ID);
    assert.notEqual(ownerTwo.principalId, ownerOne.principalId);
    assert.equal(ownerTwo.trust, "OWNER");
    assert.notEqual(service.get(ownerOne.principalId).runtimeUid, service.get(ownerTwo.principalId).runtimeUid);
    const first = service.resolveIdentity("qq", "account-a", "external-10001");
    const second = service.resolveIdentity("telegram", "bot-b", "external-10001");
    const same = service.resolveIdentity("qq", "account-a", "external-10001");
    assert.equal(first.principalId, same.principalId);
    assert.notEqual(first.principalId, "external-10001");
    assert.notEqual(first.principalId, second.principalId);
    const a = service.get(first.principalId);
    const b = service.get(second.principalId);
    assert.ok(a.runtimeUid >= PRINCIPAL_UID_MIN && a.runtimeUid <= PRINCIPAL_UID_MAX);
    assert.ok(b.runtimeUid >= PRINCIPAL_UID_MIN && b.runtimeUid <= PRINCIPAL_UID_MAX);
    assert.notEqual(a.runtimeUid, b.runtimeUid);
    assert.equal(a.runtimeGid, a.runtimeUid);
    assert.deepEqual(new PrincipalService(db, root).get(first.principalId), a);
    assert.equal(service.principalMemoryPath(first.principalId), join(root, "principals", `uid-${a.runtimeUid}`, "home", ".agent", "memory"));
    assert.equal(service.workspaceMemoryPath("conversation-a", "default"), join(service.conversationWorkspacePath("conversation-a", "default"), ".agent", "memory"));
    const proxyEnvironment = service.principalProcessEnvironment(first.principalId, "http://host.containers.internal:17890");
    assert.equal(proxyEnvironment.HTTP_PROXY, "http://host.containers.internal:17890");
    assert.equal(proxyEnvironment.https_proxy, "http://host.containers.internal:17890");
    assert.equal(proxyEnvironment.NODE_USE_ENV_PROXY, "1");
    assert.match(proxyEnvironment.NO_PROXY ?? "", /snowluma/);
    assert.equal("HTTP_PROXY" in service.principalProcessEnvironment(first.principalId), false);
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
});

test("manual state migration assigns Principal and Workspace identities to the current database", async (context) => {
  if (process.getuid?.() !== 0 || process.getgid?.() !== 0) { context.skip("manual ownership migration requires container root"); return; }
  const root = await mkdtemp(join(tmpdir(), "agent-home-principal-task-migration-"));
  const db = new SqliteStore(join(root, "data", "agent.db"));
  migrate(db, runtimeMigrations.slice(0, -1));
  const service = new PrincipalService(db, root);
  service.ensureOwnerPrincipal();
  const guest = service.resolveIdentity("qq", "account-a", "guest-1");
  const timestamp = new Date().toISOString();
  await import("node:fs/promises").then(({ mkdir, writeFile }) => Promise.all([mkdir(join(root, "config"), { recursive: true }), writeFile(join(root, "config", "bootstrap.json"), JSON.stringify({ instanceId: "migration-test", owners: [], systemAdmins: [], snowluma: { endpoint: "ws://snowluma" } }))]));
  db.run("INSERT INTO conversations(conversation_id,platform,account_id,kind,platform_conversation_id,thread_id_json,principal_id,trust,memory_scopes_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)", "conversation-a", "qq", "account-a", "group", "group-1", "null", "conversation-principal", "GUEST", "[]", timestamp, timestamp);
  db.run("INSERT INTO tasks(id,title,goal,status,requester_json,trust,origin_conversation_id,notification_conversation_id,capabilities_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)", "legacy-task", "legacy", "legacy", "CREATED", JSON.stringify({ platform: "qq", accountId: "account-a", userId: "guest-1" }), "GUEST", "conversation-a", "conversation-a", JSON.stringify({}), timestamp, timestamp);
  db.run("INSERT INTO worker_executions(id,task_id,objective,status,harness,workspace_id,workspace_access,updated_at) VALUES (?,?,?,?,?,?,?,?)", "legacy-worker", "legacy-task", "legacy", "COMPLETED", "pi", "default", "WRITE", timestamp);
  try {
    const config = { paths: { stateRoot: root }, owners: [], systemAdmins: [], runtime: { piAgentDir: join(root, "model", "pi", "agent") }, memory: { rawEpisodeDays: 30, keepExplicitForever: true, keepProvenanceForActiveFacts: true, maxPromptBytes: 24_000 } } as AppConfig;
    const result = await migrateCurrentState(config);
    assert.equal(result.tasks, 1);
    const task = db.get<{ principal_id: string; requester_json: string }>("SELECT principal_id,requester_json FROM tasks WHERE id=?", "legacy-task");
    assert.equal(task?.principal_id, guest.principalId);
    assert.equal((JSON.parse(task?.requester_json ?? "{}") as { runtimeUid?: number }).runtimeUid, service.get(guest.principalId).runtimeUid);
    const worker = db.get<{ principal_id: string; runtime_uid: number; runtime_gid: number; process_mode: string; workspace_id: string; workspace_access: string }>("SELECT principal_id,runtime_uid,runtime_gid,process_mode,workspace_id,workspace_access FROM worker_executions WHERE id=?", "legacy-worker");
    assert.equal(worker?.principal_id, guest.principalId);
    assert.equal(worker?.runtime_uid, service.get(guest.principalId).runtimeUid);
    assert.equal(worker?.runtime_gid, service.get(guest.principalId).runtimeGid);
    assert.equal(worker?.process_mode, "PRINCIPAL_BROKERED");
    assert.equal(worker?.workspace_id, "default");
    assert.equal(worker?.workspace_access, "WRITE");
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
});
