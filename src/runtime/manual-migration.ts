import type { AppConfig } from "../config.js";
import { configuredOwners } from "../config.js";
import { attenuateWorker, validateCapabilitySet } from "../auth.js";
import type { SqliteStore } from "../db.js";
import { migrate, SqliteStore as Store } from "../db.js";
import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runtimeMigrations } from "../schema.js";
import type { CapabilitySet, MemoryScope, TaskRequester, Trust } from "../shared/types.js";
import { newId, nowIso } from "../shared/ids.js";
import { MemoryService } from "./memory.js";
import { PrincipalService, OWNER_PRINCIPAL_ID, OWNER_RUNTIME_GID, OWNER_RUNTIME_UID, PRINCIPAL_UID_MAX, PRINCIPAL_UID_MIN } from "./principals.js";
import { ModelPlaneService } from "./model-plane.js";

export async function migrateCurrentState(config: AppConfig): Promise<{ principals: number; tasks: number; workers: number; conversations: number }> {
  if (process.getuid?.() !== 0 || process.getgid?.() !== 0) throw new Error("MANUAL_STATE_MIGRATION_REQUIRES_CONTAINER_ROOT");
  const db = new Store(`${config.paths.stateRoot}/data/agent.db`);
  try {
    migrate(db, runtimeMigrations);
    if (db.get("SELECT 1 AS found FROM runtime_meta WHERE key='principal_workspace_manual_migration'")) {
      assertMigrated(db);
      return migrationCounts(db);
    }
    const principalService = new PrincipalService(db, config.paths.stateRoot);
    const owners = configuredOwners(config);
    principalService.ensureOwnerPrincipal();
    assignMissingRuntimeIds(db);
    splitConfiguredOwnerIdentities(db, owners);
    assignMissingRuntimeIds(db);

    const tasks = db.all<{ id: string; requester_json: string; principal_id: string | null }>("SELECT id,requester_json,principal_id FROM tasks ORDER BY created_at,id");
    const activeWorkers = Number(db.get<{ count: number }>("SELECT count(*) AS count FROM worker_executions WHERE status IN ('PENDING','STARTING','RUNNING','WAITING_USER','STOPPING')")?.count ?? 0);
    if (activeWorkers > 0) throw new Error(`MANUAL_MIGRATION_REQUIRES_QUIESCED_WORKERS:${activeWorkers}`);
    for (const task of tasks) {
      const requester = parseRequester(task.requester_json, task.id);
      const principalId = requester.platform && requester.accountId && requester.userId
        ? principalService.resolveIdentity(requester.platform, requester.accountId, requester.userId, owners).principalId
        : requester.principalId ?? task.principal_id;
      if (!principalId) throw new Error(`TASK_PRINCIPAL_UNRESOLVED:${task.id}`);
      const principal = principalService.get(principalId);
      requester.principalId = principalId;
      requester.runtimeUid = principal.runtimeUid;
      requester.runtimeGid = principal.runtimeGid;
      const taskRow = db.get<{ capabilities_json: string; origin_conversation_id: string }>("SELECT capabilities_json,origin_conversation_id FROM tasks WHERE id=?", task.id);
      let taskCapabilities: CapabilitySet;
      try { taskCapabilities = validateCapabilitySet(JSON.parse(String(taskRow?.capabilities_json))); }
      catch { throw new Error(`TASK_CAPABILITIES_INVALID:${task.id}`); }
      taskCapabilities.memory.allowedScopes = [...new Set([...taskCapabilities.memory.allowedScopes, `workspace:${taskRow?.origin_conversation_id}` as MemoryScope])];
      db.run("UPDATE tasks SET principal_id=?,requester_json=?,capabilities_json=? WHERE id=?", principalId, JSON.stringify(requester), JSON.stringify(taskCapabilities), task.id);
      db.run("UPDATE worker_executions SET principal_id=?,runtime_uid=?,runtime_gid=?,process_mode='PRINCIPAL_BROKERED' WHERE task_id=?", principalId, principal.runtimeUid, principal.runtimeGid, task.id);
      db.run("UPDATE artifacts SET source_principal_id=? WHERE owner_task_id=? AND source_principal_id IS NULL", principalId, task.id);
    }

    const conversations = db.all<{ conversation_id: string }>("SELECT conversation_id FROM conversations ORDER BY conversation_id");
    for (const { conversation_id: conversationId } of conversations) {
      await principalService.ensureConversationWorkspace(conversationId);
      const row = db.get<{ memory_scopes_json: string }>("SELECT memory_scopes_json FROM conversations WHERE conversation_id=?", conversationId);
      let scopes: string[];
      try { scopes = JSON.parse(row?.memory_scopes_json ?? "[]") as string[]; } catch { throw new Error(`CONVERSATION_MEMORY_SCOPES_INVALID:${conversationId}`); }
      if (!scopes.includes(`workspace:${conversationId}`)) scopes.push(`workspace:${conversationId}`);
      db.run("UPDATE conversations SET memory_scopes_json=? WHERE conversation_id=?", JSON.stringify(scopes), conversationId);
    }
    const workers = db.all<{ id: string; task_id: string; workspace_id: string | null; workspace_access: "READ" | "WRITE" | null; capabilities_json: string | null; principal_id: string | null }>("SELECT id,task_id,workspace_id,workspace_access,capabilities_json,principal_id FROM worker_executions ORDER BY id");
    for (const worker of workers) {
      if (!worker.principal_id) throw new Error(`WORKER_PRINCIPAL_UNRESOLVED:${worker.id}`);
      const task = db.get<{ origin_conversation_id: string }>("SELECT origin_conversation_id FROM tasks WHERE id=?", worker.task_id);
      if (!task) throw new Error(`WORKER_TASK_MISSING:${worker.id}`);
      const workspaceId = worker.workspace_id ?? "default";
      await principalService.ensureConversationWorkspacePath(task.origin_conversation_id, workspaceId);
      const identity = principalService.get(worker.principal_id);
      const workspaceGroup = db.get<{ runtime_gid: number }>("SELECT runtime_gid FROM conversation_workspaces WHERE conversation_id=?", task.origin_conversation_id)?.runtime_gid;
      if (!workspaceGroup) throw new Error(`WORKER_WORKSPACE_GID_MISSING:${worker.id}`);
      const access = worker.workspace_access ?? "WRITE";
      const taskCapabilities = validateCapabilitySet(JSON.parse(String(db.get<{ capabilities_json: string }>("SELECT capabilities_json FROM tasks WHERE id=?", worker.task_id)?.capabilities_json)));
      const workerCapabilities = worker.capabilities_json
        ? validateCapabilitySet(JSON.parse(worker.capabilities_json))
        : attenuateWorker(taskCapabilities, {
          memory: { allowedScopes: taskCapabilities.memory.allowedScopes },
          projects: [{ projectId: workspaceId, access }],
          qq: { readConversations: [], sendConversations: [] },
          plugins: { allowedActions: taskCapabilities.plugins.allowedActions, ...(taskCapabilities.plugins.allowedPermissions ? { allowedPermissions: taskCapabilities.plugins.allowedPermissions } : {}) },
          artifacts: { readableArtifactAuthorities: taskCapabilities.artifacts.readableArtifactAuthorities, publishTaskIds: [worker.task_id], allowedDestinations: [] },
          tasks: { canCreate: false, visibleTaskIds: [], canCancel: false, canFollowUp: false },
        });
      workerCapabilities.memory.allowedScopes = [...new Set([...workerCapabilities.memory.allowedScopes, `workspace:${task.origin_conversation_id}` as MemoryScope])];
      db.run("UPDATE worker_executions SET workspace_id=?,workspace_gid=?,workspace_access=?,runtime_uid=?,runtime_gid=?,process_mode='PRINCIPAL_BROKERED',capabilities_json=? WHERE id=?", workspaceId, workspaceGroup, access, identity.runtimeUid, identity.runtimeGid, JSON.stringify(workerCapabilities), worker.id);
    }
    db.run("UPDATE owned_processes SET process_kind='PRINCIPAL_EXEC' WHERE process_kind='GUEST_EXEC'");

    const principals = db.all<{ principal_id: string }>("SELECT principal_id FROM principals ORDER BY runtime_uid");
    for (const { principal_id: principalId } of principals) await principalService.ensurePrincipalDirectories(principalId);
    const memory = new MemoryService(db, owners, config.memory);
    memory.migrateMergedPrincipalMemory(OWNER_PRINCIPAL_ID);
    memory.isolateLegacyPrincipalScopes();
    await updateBootstrapConfig(config, owners);
    const modelPlane = new ModelPlaneService(db, config.paths.stateRoot, join(config.paths.stateRoot, "model", "pi", "agent"));
    await modelPlane.ensure();
    await modelPlane.migrateLegacyState();
    await rm(join(config.paths.stateRoot, "principals", `uid-${OWNER_RUNTIME_UID}`, "home", ".pi", "agent"), { recursive: true, force: true });

    assertMigrated(db);
    db.run("INSERT INTO runtime_meta(key,value) VALUES ('principal_workspace_manual_migration','1') ON CONFLICT(key) DO UPDATE SET value='1'");
    return { principals: principals.length, tasks: tasks.length, workers: workers.length, conversations: conversations.length };
  } finally {
    db.close();
  }
}

export async function migrateBootstrapStateConfig(stateRoot: string): Promise<void> {
  const path = join(stateRoot, "config", "bootstrap.json");
  const value = JSON.parse(await readFile(path, "utf8")) as Record<string, any>;
  if (!Array.isArray(value.owners) && value.owner) value.owners = [value.owner];
  delete value.owner;
  value.owners ??= [];
  value.systemAdmins ??= value.owners.map((owner: Record<string, unknown>) => ({ ...owner }));
  if (value.guest?.memoryBytes === 2 * 1024 * 1024 * 1024) value.guest.memoryBytes = 16 * 1024 * 1024 * 1024;
  value.runtime = { ...(value.runtime ?? {}), piAgentDir: join(stateRoot, "model", "pi", "agent") };
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

function assertMigrated(db: SqliteStore): void {
  const checks = [
    ["tasks", "SELECT count(*) AS count FROM tasks WHERE principal_id IS NULL OR principal_id=''"],
    ["workers", "SELECT count(*) AS count FROM worker_executions WHERE principal_id IS NULL OR workspace_gid IS NULL OR runtime_uid IS NULL OR runtime_gid IS NULL OR workspace_id IS NULL OR workspace_access IS NULL OR capabilities_json IS NULL OR process_mode!='PRINCIPAL_BROKERED'"],
    ["principal_ids", "SELECT count(*) AS count FROM principals WHERE runtime_uid IS NULL OR runtime_gid IS NULL"],
    ["workspace_gids", "SELECT count(*) AS count FROM conversations c LEFT JOIN conversation_workspaces cw ON cw.conversation_id=c.conversation_id WHERE cw.runtime_gid IS NULL"],
    ["guest_process_rows", "SELECT count(*) AS count FROM owned_processes WHERE process_kind='GUEST_EXEC'"],
  ] as const;
  const failures = checks.map(([name, sql]) => [name, Number(db.get<{ count: number }>(sql)?.count ?? 0)] as const).filter(([, count]) => count > 0);
  if (failures.length) throw new Error(`MANUAL_MIGRATION_INCOMPLETE:${failures.map(([name, count]) => `${name}=${count}`).join(":")}`);
}

function migrationCounts(db: SqliteStore): { principals: number; tasks: number; workers: number; conversations: number } {
  const count = (table: string) => Number(db.get<{ count: number }>(`SELECT count(*) AS count FROM ${table}`)?.count ?? 0);
  return { principals: count("principals"), tasks: count("tasks"), workers: count("worker_executions"), conversations: count("conversations") };
}

async function updateBootstrapConfig(config: AppConfig, owners: ReturnType<typeof configuredOwners>): Promise<void> {
  const path = join(config.paths.stateRoot, "config", "bootstrap.json");
  const current = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  current.owners = owners;
  current.systemAdmins = config.systemAdmins ?? owners;
  current.runtime = { ...(current.runtime as Record<string, unknown> ?? {}), piAgentDir: join(config.paths.stateRoot, "model", "pi", "agent") };
  delete current.owner;
  await writeFile(path, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

function assignMissingRuntimeIds(db: SqliteStore): void {
  db.transaction(() => {
    const used = new Set(db.all<{ runtime_uid: number }>("SELECT runtime_uid FROM principals WHERE runtime_uid IS NOT NULL").map((row) => Number(row.runtime_uid)));
    const rows = db.all<{ principal_id: string; trust: Trust; runtime_uid: number | null; runtime_gid: number | null }>("SELECT principal_id,trust,runtime_uid,runtime_gid FROM principals ORDER BY CASE WHEN principal_id=? THEN 0 ELSE 1 END,created_at,principal_id", OWNER_PRINCIPAL_ID);
    let nextUid = PRINCIPAL_UID_MIN;
    for (const row of rows) {
      let uid = row.runtime_uid;
      if (uid === null) {
        if (row.principal_id === OWNER_PRINCIPAL_ID) {
          if (used.has(OWNER_RUNTIME_UID)) throw new Error("OWNER_RUNTIME_UID_CONFLICT");
          uid = OWNER_RUNTIME_UID;
        } else {
          while (nextUid <= PRINCIPAL_UID_MAX && used.has(nextUid)) nextUid++;
          if (nextUid > PRINCIPAL_UID_MAX) throw new Error("PRINCIPAL_UID_RANGE_EXHAUSTED");
          uid = nextUid++;
        }
      }
      used.add(uid);
      const gid = row.runtime_gid ?? (row.principal_id === OWNER_PRINCIPAL_ID ? OWNER_RUNTIME_GID : uid);
      db.run("UPDATE principals SET runtime_uid=?,runtime_gid=? WHERE principal_id=?", uid, gid, row.principal_id);
    }
  });
}

function splitConfiguredOwnerIdentities(db: SqliteStore, owners: ReturnType<typeof configuredOwners>): void {
  const bindings = db.all<{ platform: string; account_id: string; user_id: string }>("SELECT platform,account_id,user_id FROM platform_identities WHERE principal_id=? ORDER BY platform,account_id,user_id", OWNER_PRINCIPAL_ID);
  const canonical = bindings[0] ? { platform: bindings[0].platform, accountId: bindings[0].account_id, userId: bindings[0].user_id } : owners[0];
  for (const owner of owners) {
    const existing = db.get<{ principal_id: string }>("SELECT principal_id FROM platform_identities WHERE platform=? AND account_id=? AND user_id=?", owner.platform, owner.accountId, owner.userId);
    const isCanonical = canonical?.platform === owner.platform && canonical.accountId === owner.accountId && canonical.userId === owner.userId;
    let principalId = existing?.principal_id;
    if (!principalId) principalId = isCanonical ? OWNER_PRINCIPAL_ID : newId("principal");
    else if (principalId === OWNER_PRINCIPAL_ID && !isCanonical) principalId = newId("principal");
    if (!db.get("SELECT 1 AS found FROM principals WHERE principal_id=?", principalId)) db.run("INSERT INTO principals(principal_id,trust,created_at) VALUES (?,?,?)", principalId, "OWNER", nowIso());
    else db.run("UPDATE principals SET trust='OWNER' WHERE principal_id=?", principalId);
    db.run("INSERT INTO platform_identities(platform,account_id,user_id,principal_id) VALUES (?,?,?,?) ON CONFLICT(platform,account_id,user_id) DO UPDATE SET principal_id=excluded.principal_id", owner.platform, owner.accountId, owner.userId, principalId);
  }
}

function parseRequester(json: string, taskId: string): TaskRequester {
  let requester: Partial<TaskRequester>;
  try { requester = JSON.parse(json) as Partial<TaskRequester>; }
  catch { throw new Error(`TASK_REQUESTER_INVALID:${taskId}`); }
  return {
    platform: typeof requester.platform === "string" ? requester.platform : "",
    accountId: typeof requester.accountId === "string" ? requester.accountId : "",
    userId: typeof requester.userId === "string" ? requester.userId : "",
    ...(requester.principalId ? { principalId: requester.principalId } : {}),
  };
}
