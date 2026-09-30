import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore, migrate } from "../src/db.js";
import { runtimeMigrations } from "../src/schema.js";
import { PrincipalService, PRINCIPAL_UID_MAX, PRINCIPAL_UID_MIN } from "../src/runtime/principals.js";

test("Principal runtime identities are stable, unique and independent of platform IDs", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-home-principal-id-"));
  const db = new SqliteStore(join(root, "agent.db"));
  migrate(db, runtimeMigrations);
  try {
    const service = new PrincipalService(db, root);
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

test("schema v24 removes role fields and rekeys the former fixed Principal without losing identity or memory", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-home-roleless-schema-"));
  const db = new SqliteStore(join(root, "agent.db"));
  migrate(db, runtimeMigrations.slice(0, -1));
  const now = new Date().toISOString();
  db.run("INSERT INTO principals(principal_id,trust,created_at,runtime_uid,runtime_gid) VALUES (?,?,?,?,?)", "principal:owner", "OWNER", now, 10001, 10001);
  db.run("INSERT INTO platform_identities(platform,account_id,user_id,principal_id) VALUES (?,?,?,?)", "qq", "default", "admin-user", "principal:owner");
  db.run("INSERT INTO conversations(conversation_id,platform,account_id,kind,platform_conversation_id,thread_id_json,principal_id,trust,memory_scopes_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)", "conversation-a", "qq", "default", "private", "admin-user", "null", "principal:owner", "OWNER", JSON.stringify(["user:principal:owner", "workspace:conversation-a", "owner_private"]), now, now);
  const capabilities = { memory: { allowedScopes: ["user:principal:owner", "workspace:conversation-a", "owner_private", "global_agent"] }, projects: [], qq: { readConversations: [], sendConversations: [] }, plugins: { allowedActions: [] }, artifacts: { readableArtifactAuthorities: [], publishTaskIds: [], allowedDestinations: [] }, tasks: { canCreate: true, visibleTaskIds: [], canCancel: true, canFollowUp: true } };
  db.run("INSERT INTO tasks(id,title,goal,status,requester_json,trust,origin_conversation_id,notification_conversation_id,capabilities_json,created_at,updated_at,principal_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", "task-a", "task", "goal", "CREATED", JSON.stringify({ principalId: "principal:owner" }), "OWNER", "conversation-a", "conversation-a", JSON.stringify(capabilities), now, now, "principal:owner");
  db.run("INSERT INTO memory_episodes(id,scope,source_json,content,occurred_at,ingested_at,trust) VALUES (?,?,?,?,?,?,?)", "episode-a", "owner_private", JSON.stringify({ type: "manual", sourceId: "source-a" }), "private memory", now, now, "owner");
  db.run("INSERT INTO memory_episodes(id,scope,source_json,content,occurred_at,ingested_at,trust) VALUES (?,?,?,?,?,?,?)", "episode-ambiguous", "project:historic-project", JSON.stringify({ type: "manual", sourceId: "source-ambiguous" }), "ambiguous legacy memory", now, now, "guest");
  try {
    migrate(db, runtimeMigrations);
    const identity = db.get<{ principal_id: string }>("SELECT principal_id FROM platform_identities WHERE platform='qq' AND account_id='default' AND user_id='admin-user'")!.principal_id;
    assert.match(identity, /^principal_[A-Za-z0-9_-]+$/);
    assert.equal(new PrincipalService(db, root).get(identity).runtimeUid, 10001);
    assert.equal(db.get<{ principal_id: string }>("SELECT principal_id FROM tasks WHERE id='task-a'")?.principal_id, identity);
    assert.deepEqual(JSON.parse(db.get<{ requester_json: string }>("SELECT requester_json FROM tasks WHERE id='task-a'")!.requester_json), { principalId: identity });
    assert.deepEqual(JSON.parse(db.get<{ capabilities_json: string }>("SELECT capabilities_json FROM tasks WHERE id='task-a'")!.capabilities_json).memory.allowedScopes, [`user:${identity}`, "workspace:conversation-a"]);
    assert.equal(db.get<{ scope: string }>("SELECT scope FROM memory_episodes WHERE id='episode-a'")?.scope, `user:${identity}`);
    assert.equal(db.get<{ scope: string }>("SELECT scope FROM memory_episodes WHERE id='episode-ambiguous'")?.scope, "user:legacy_unassigned");
    assert.deepEqual(db.all<{ name: string }>("PRAGMA table_info(principals)").map((column) => column.name).includes("trust"), false);
    assert.deepEqual(db.all<{ name: string }>("PRAGMA table_info(conversations)").map((column) => column.name).filter((name) => ["principal_id", "trust"].includes(name)), []);
    assert.equal(db.all<{ name: string }>("PRAGMA table_info(tasks)").some((column) => column.name === "trust"), false);
    assert.equal(db.all<{ name: string }>("PRAGMA table_info(memory_episodes)").some((column) => column.name === "trust"), false);
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
});
