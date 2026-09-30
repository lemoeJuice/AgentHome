import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore, migrate } from "../src/db.js";
import { runtimeMigrations } from "../src/schema.js";
import { TaskService, classifyWorkspaceErrorCode } from "../src/runtime/tasks.js";
import { RuntimeToolServer } from "../src/runtime/tools.js";
import type { RuntimeToolContext } from "../src/runtime/tools.js";
import registerWorkerTools from "../src/runtime/worker-tools.js";
import { ArtifactService } from "../src/runtime/artifacts.js";
import type { AppConfig } from "../src/config.js";
import type { Logger } from "../src/shared/logger.js";
import type { PrincipalService } from "../src/runtime/principals.js";
import type { CapabilitySet, TaskRequester } from "../src/shared/types.js";

const logger = { child: () => logger, info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger;

function capabilities(projectAccess: "READ" | "WRITE" = "WRITE"): CapabilitySet {
  return {
    memory: { allowedScopes: ["workspace:conversation"] },
    projects: [{ projectId: "*", access: "WRITE" }],
    qq: { readConversations: ["conversation"], sendConversations: ["conversation"] },
    plugins: { allowedActions: [] },
    artifacts: { readableArtifactAuthorities: ["agent-home"], publishTaskIds: ["*"], allowedDestinations: ["conversation"] },
    tasks: { canCreate: true, visibleTaskIds: [], canCancel: true, canFollowUp: true },
    ...(projectAccess === "READ" ? { projects: [{ projectId: "*", access: "READ" }] } : {}),
  };
}

function testConfig(): AppConfig {
  return {
    systemAdmins: [{ platform: "qq", accountId: "default", userId: "owner" }],
    principalExecution: { maxWorkersPerPrincipal: 4, taskTimeoutMs: 30_000, commandTimeoutMs: 5000, cpuSeconds: 60, memoryBytes: 16 * 1024 * 1024 * 1024, pids: 20, maxFileBytes: 1_000_000, workspaceQuotaBytes: 10_000_000, cacheQuotaBytes: 10_000_000, artifactQuotaBytes: 10_000_000 },
    runtime: { maxWorkers: 2, maxWorkersTotal: 4, maxWorkersPerProject: 4, maxWorkersPerRequester: 4, maxTasks: 10, maxTasksPerRequester: 5, maxTasksPerPrincipal: 5, maxArtifactBytes: 100_000, piCommand: "pi", piTimeoutMs: 5000, workerSandboxCommand: "bwrap", piAgentDir: "/tmp/pi-agent" },
  } as AppConfig;
}

function fakePrincipals(root: string): PrincipalService {
  const principal = (principalId: string) => ({ principalId, runtimeUid: 20001, runtimeGid: 20001 });
  const principalRoot = (principalId: string) => join(root, "principals", principalId);
  return {
    get: principal,
    principalMemoryPath(principalId: string) { return join(principalRoot(principalId), "home", ".agent", "memory"); },
    workspaceMemoryPath(conversationId: string, workspaceId: string) { return join(root, "conversation-workspaces", conversationId, "projects", workspaceId, ".agent", "memory"); },
    async ensurePrincipalDirectories(principalId: string) {
      const base = principalRoot(principalId);
      const dirs = { root: base, home: join(base, "home"), projects: join(base, "projects"), cache: join(base, "cache"), artifacts: join(base, "artifacts"), agent: join(base, "agent") };
      await Promise.all(Object.values(dirs).map((path) => mkdir(path, { recursive: true, mode: 0o700 })));
      return dirs;
    },
    async workspacePath(principalId: string, workspaceId: string) {
      const path = join(principalRoot(principalId), "projects", workspaceId);
      await mkdir(path, { recursive: true, mode: 0o700 });
      return path;
    },
    async ensureConversationWorkspace(conversationId: string) {
      const base = join(root, "conversation-workspaces", conversationId);
      const dirs = { root: base, home: join(base, "home"), projects: join(base, "projects"), cache: join(base, "cache"), uid: 30001, gid: 30001 };
      await Promise.all(Object.values(dirs).filter((value): value is string => typeof value === "string").map((path) => mkdir(path, { recursive: true, mode: 0o700 })));
      return dirs;
    },
    async ensureConversationWorkspacePath(conversationId: string, workspaceId: string) {
      const path = join(root, "conversation-workspaces", conversationId, "projects", workspaceId);
      await mkdir(path, { recursive: true, mode: 0o700 });
      return path;
    },
    conversationWorkspacePath(conversationId: string, workspaceId: string) { return join(root, "conversation-workspaces", conversationId, "projects", workspaceId); },
    async conversationWorkspaceProcessEnvironment(conversationId: string) { return { ...process.env, HOME: join(root, "conversation-workspaces", conversationId, "home") }; },
    principalProcessEnvironment(principalId: string) { return { ...process.env, HOME: join(principalRoot(principalId), "home") }; },
  } as unknown as PrincipalService;
}

async function createExecHelper(root: string): Promise<string> {
  const helper = join(root, "principal-exec-helper.mjs");
  await writeFile(helper, `#!/usr/bin/env node\nimport { spawnSync } from "node:child_process";\nconst i=process.argv.indexOf("--");\nconst r=spawnSync(process.argv[i+1],process.argv.slice(i+2),{cwd:process.cwd(),env:process.env,encoding:"utf8"});\nif(r.stdout)process.stdout.write(r.stdout);\nif(r.stderr)process.stderr.write(r.stderr);\nprocess.exitCode=r.status??1;\n`);
  await chmod(helper, 0o700);
  return helper;
}

test("default Worker profile is writable and Pi tool dispatch keeps Principal ExecutionContext", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-home-workspace-context-"));
  const db = new SqliteStore(":memory:"); migrate(db, runtimeMigrations);
  const principals = fakePrincipals(root);
  const helper = await createExecHelper(root);
  const config = testConfig();
  const requester: TaskRequester = { platform: "qq", accountId: "default", userId: "guest-user", principalId: "principal_guest-test" };
  const taskCaps = capabilities();
  const service = new TaskService(db, { } as never, new ArtifactService(db, root), config, { workerRoot: root, principals, principalExecCommand: helper }, logger);
  const task = service.createTask({ title: "write own workspace", goal: "create a file", requester, originConversationId: "conversation", notificationConversationId: "conversation", parentCapabilities: taskCaps });
  const workerId = "worker_guest-write";
  const workerCaps = { ...taskCaps, projects: [{ projectId: "default", access: "WRITE" as const }] };
  const timestamp = new Date().toISOString();
  db.run("INSERT INTO worker_executions(id,task_id,objective,status,harness,workspace_id,workspace_access,capabilities_json,updated_at,principal_id,runtime_uid,runtime_gid,workspace_scope_id,process_mode,workspace_gid) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", workerId, task.id, "create a file", "RUNNING", "pi", "default", "WRITE", JSON.stringify(workerCaps), timestamp, requester.principalId!, 20001, 20001, "conversation:conversation:default", "PRINCIPAL_BROKERED", 30001);

  try {
    const execution = await service.executionContext(workerId);
    const expectedWorkspace = await principals.ensureConversationWorkspacePath("conversation", "default");
    assert.equal(execution.taskId, task.id);
    assert.equal(execution.principalId, requester.principalId);
    assert.equal(execution.uid, 20001);
    assert.equal(execution.gid, 20001);
    assert.equal(execution.workspaceGid, 30001);
    assert.equal(execution.workspaceId, "default");
    assert.equal(execution.workspace, expectedWorkspace);
    assert.equal(execution.workspaceAccess, "WRITE");
    assert.equal(execution.executionProfile, "PRINCIPAL_READ_WRITE");
    assert.deepEqual(execution.capabilities.projects, [{ projectId: "default", access: "WRITE" }]);
    assert.equal(execution.contextSource, "durable-worker-record");
    assert.notEqual(execution.workspace, join(root, "projects", "default"));
    const envResult = await service.execute(execution, { command: "printf '%s\\n%s\\n%s\\n%s' \"$HOME\" \"$WORKSPACE\" \"$AGENT_PERSONAL_MEMORY\" \"$AGENT_WORKSPACE_MEMORY\"" });
    assert.deepEqual(String((envResult as { stdout: string }).stdout).trim().split("\n"), [join(root, "principals", requester.principalId!, "home"), expectedWorkspace, join(root, "principals", requester.principalId!, "home", ".agent", "memory"), join(expectedWorkspace, ".agent", "memory")]);

    const context: RuntimeToolContext = {
      conversationId: "conversation",
      requesterId: requester.userId,
      requester,
      address: { platform: "qq", accountId: "default", kind: "private", platformConversationId: requester.userId, threadId: null },
      capabilities: workerCaps,
      taskId: task.id,
      workerId,
      executionContextId: execution.executionContextId,
    };
    const socketPath = join(root, "worker-tools.sock");
    const token = "worker-context-token";
    const server = new RuntimeToolServer(socketPath, (candidate) => candidate === token ? context : undefined, async (action, input, resolved) => {
      assert.equal(resolved.taskId, task.id);
      assert.equal(resolved.workerId, workerId);
      const current = await service.executionContext(resolved.workerId!);
      assert.equal(current.principalId, requester.principalId);
      assert.equal(current.workspace, expectedWorkspace);
      assert.equal(current.uid, 20001);
      assert.equal(current.workspaceGid, 30001);
      assert.deepEqual(current.capabilities.projects, [{ projectId: "default", access: "WRITE" }]);
      if (action === "workspace_write") return await service.writeFile(current, String((input as Record<string, unknown>).path), String((input as Record<string, unknown>).content));
      throw new Error("TEST_ACTION_UNEXPECTED");
    });
    await server.start();
    const previousSocket = process.env.AGENT_HOME_RUNTIME_TOOL_SOCKET;
    const previousToken = process.env.AGENT_HOME_RUNTIME_TOOL_TOKEN;
    process.env.AGENT_HOME_RUNTIME_TOOL_SOCKET = socketPath;
    process.env.AGENT_HOME_RUNTIME_TOOL_TOKEN = token;
    try {
      const tools = new Map<string, Parameters<Parameters<typeof registerWorkerTools>[0]["registerTool"]>[0]>();
      registerWorkerTools({ registerTool: (definition) => { tools.set(definition.name, definition); } });
      const writeTool = tools.get("workspace_write");
      assert.ok(writeTool);
      const result = await writeTool.execute("tool-call", { path: "generated/tool.js", content: "export const ready = true;\n" }, new AbortController().signal);
      assert.equal(result.isError, undefined);
      assert.equal(await readFile(join(expectedWorkspace, "generated/tool.js"), "utf8"), "export const ready = true;\n");
    } finally {
      await server.stop();
      if (previousSocket === undefined) delete process.env.AGENT_HOME_RUNTIME_TOOL_SOCKET; else process.env.AGENT_HOME_RUNTIME_TOOL_SOCKET = previousSocket;
      if (previousToken === undefined) delete process.env.AGENT_HOME_RUNTIME_TOOL_TOKEN; else process.env.AGENT_HOME_RUNTIME_TOOL_TOKEN = previousToken;
    }
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Workers cannot write another Principal workspace and read-only profiles stay read-only", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-home-workspace-isolation-"));
  const db = new SqliteStore(":memory:"); migrate(db, runtimeMigrations);
  const principals = fakePrincipals(root);
  const config = testConfig();
  const requester: TaskRequester = { platform: "qq", accountId: "default", userId: "guest", principalId: "principal_guest-isolated" };
  const caps = capabilities();
  const service = new TaskService(db, {} as never, new ArtifactService(db, root), config, { workerRoot: root, principals, principalExecCommand: await createExecHelper(root) }, logger);
  const task = service.createTask({ title: "isolation", goal: "isolation", requester, originConversationId: "conversation", notificationConversationId: "conversation", parentCapabilities: caps });
  const otherWorkspace = await principals.ensureConversationWorkspacePath("conversation-other", "default");
  const timestamp = new Date().toISOString();
  const insertWorker = (id: string, access: "READ" | "WRITE", projectAccess: "READ" | "WRITE") => {
    const workerCaps = { ...caps, projects: [{ projectId: "default", access: projectAccess }] };
    db.run("INSERT INTO worker_executions(id,task_id,objective,status,harness,workspace_id,workspace_access,capabilities_json,updated_at,principal_id,runtime_uid,runtime_gid,workspace_scope_id,process_mode,workspace_gid) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", id, task.id, id, "RUNNING", "pi", "default", access, JSON.stringify(workerCaps), timestamp, requester.principalId!, 20001, 20001, "conversation:conversation:default", "PRINCIPAL_BROKERED", 30001);
  };
  insertWorker("worker-guest-write", "WRITE", "WRITE");
  insertWorker("worker-guest-readonly", "READ", "READ");
  try {
    const writer = await service.executionContext("worker-guest-write");
    await assert.rejects(() => service.writeFile(writer, "../../../principal_other/projects/default/escaped.txt", "no"), /WORKSPACE_PATH_DENIED/);
    assert.equal(await readFile(join(otherWorkspace, "escaped.txt"), "utf8").catch(() => undefined), undefined);
    const readonly = await service.executionContext("worker-guest-readonly");
    assert.equal(readonly.executionProfile, "PRINCIPAL_READ_ONLY");
    await assert.rejects(() => service.writeFile(readonly, "no.txt", "no"), /WORKER_PROFILE_READ_ONLY/);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("durable Principal Worker context fails closed and differentiates workspace failures", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-home-workspace-recovery-"));
  const db = new SqliteStore(":memory:"); migrate(db, runtimeMigrations);
  const principals = fakePrincipals(root);
  const requester: TaskRequester = { platform: "qq", accountId: "default", userId: "guest", principalId: "principal_guest-recovery" };
  const caps = capabilities();
  const service = new TaskService(db, {} as never, new ArtifactService(db, root), testConfig(), { workerRoot: root, principals, principalExecCommand: await createExecHelper(root) }, logger);
  const task = service.createTask({ title: "recovered", goal: "recovered", requester, originConversationId: "conversation", notificationConversationId: "conversation", parentCapabilities: caps });
  const timestamp = new Date().toISOString();
  const insert = (id: string, snapshot: CapabilitySet | null) => db.run("INSERT INTO worker_executions(id,task_id,objective,status,harness,workspace_id,workspace_access,capabilities_json,updated_at,principal_id,runtime_uid,runtime_gid,workspace_scope_id,process_mode,workspace_gid) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", id, task.id, id, "RUNNING", "pi", "default", "WRITE", snapshot ? JSON.stringify(snapshot) : null, timestamp, requester.principalId!, 20001, 20001, "conversation:conversation:default", "PRINCIPAL_BROKERED", 30001);
  insert("worker-recovered", { ...caps, projects: [{ projectId: "default", access: "WRITE" }] });
  insert("worker-no-capability-snapshot", null);
  insert("worker-missing-project-capability", { ...caps, projects: [] });
  insert("worker-write-capability-missing", { ...caps, projects: [{ projectId: "default", access: "READ" }] });
  try {
    const first = await service.executionContext("worker-recovered");
    const rebuiltService = new TaskService(db, {} as never, new ArtifactService(db, root), testConfig(), { workerRoot: root, principals, principalExecCommand: await createExecHelper(root) }, logger);
    const rebuilt = await rebuiltService.executionContext("worker-recovered");
    assert.deepEqual(rebuilt, first);
    assert.equal(rebuilt.contextSource, "durable-worker-record");
    assert.equal(rebuilt.workspace, await principals.ensureConversationWorkspacePath("conversation", "default"));
    await assert.rejects(() => service.readFile(rebuilt, "not-present.txt"), /WORKSPACE_PATH_NOT_FOUND/);
    await assert.rejects(() => service.executionContext("worker-no-capability-snapshot"), /WORKER_CAPABILITY_SNAPSHOT_MISSING/);
    await assert.rejects(() => service.executionContext("worker-missing-project-capability"), /WORKSPACE_CAPABILITY_MISSING/);
    await assert.rejects(() => service.executionContext("worker-write-capability-missing"), /WORKSPACE_WRITE_CAPABILITY_MISSING/);
    assert.equal(classifyWorkspaceErrorCode("EACCES"), "WORKSPACE_UNIX_PERMISSION_DENIED");
    assert.equal(classifyWorkspaceErrorCode("EPERM"), "WORKSPACE_UNIX_PERMISSION_DENIED");
    assert.equal(classifyWorkspaceErrorCode("EROFS"), "WORKSPACE_FILESYSTEM_READ_ONLY");
    assert.equal(classifyWorkspaceErrorCode("ENOENT"), "WORKSPACE_PATH_NOT_FOUND");
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
