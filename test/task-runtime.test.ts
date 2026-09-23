import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore, migrate } from "../src/db.js";
import { runtimeMigrations } from "../src/schema.js";
import { TaskService } from "../src/runtime/tasks.js";
import { WORKER_CONTROL_PREFIX } from "../src/runtime/tasks.js";
import { ArtifactService } from "../src/runtime/artifacts.js";
import type { PiHarness, PiProcessIdentity, PiProcessInspection, PiSandbox, PiSession } from "../src/runtime/pi.js";
import type { AppConfig } from "../src/config.js";
import type { Logger } from "../src/shared/logger.js";

class TestPi implements PiHarness {
  readonly steers: string[] = [];
  readonly aborts: string[] = [];
  async createSession(sessionPath: string): Promise<PiSession> { return { sessionId: `pi-${this.steers.length}`, sessionPath }; }
  async resumeSession(): Promise<boolean> { return true; }
  async send(): Promise<string> { return `${WORKER_CONTROL_PREFIX}{"type":"question","question":"Which environment?"}`; }
  async steer(_session: PiSession, prompt: string): Promise<string> { this.steers.push(prompt); return `${WORKER_CONTROL_PREFIX}{"type":"progress","summary":"answer received"}`; }
  async abort(session: PiSession): Promise<boolean> { this.aborts.push(session.sessionId); return true; }
  async inspect(): Promise<"available" | "missing" | "unknown"> { return "available"; }
}

class CompletingPi extends TestPi {
  async send(): Promise<string> { return "verified result"; }
}

class StructuredPi extends TestPi {
  async send(_session: PiSession, _prompt: string, options?: { cwd?: string }): Promise<string> {
    await writeFile(join(options?.cwd ?? "/tmp", "result.txt"), "verified artifact");
    return [
      `${WORKER_CONTROL_PREFIX}{"type":"progress","summary":"workspace checked","currentAction":"writing result"}`,
      `${WORKER_CONTROL_PREFIX}{"type":"artifact","path":"result.txt","mime":"text/plain"}`,
      `${WORKER_CONTROL_PREFIX}{"type":"finish","outcome":"COMPLETED","summary":"structured result"}`,
    ].join("\n");
  }
}

class RecoveryPi extends TestPi {
  readonly inspections = new Map<number, PiProcessInspection>();
  readonly terminated: number[] = [];
  resumed = 0;
  resumeOptions?: { cwd?: string; sandbox?: PiSandbox };
  async send(): Promise<string> { return "recovered result"; }
  async steer(): Promise<string> { return `${WORKER_CONTROL_PREFIX}{"type":"progress","summary":"mailbox replayed"}`; }
  async resumeSession(session: PiSession, options?: { cwd?: string; sandbox?: PiSandbox }): Promise<boolean> { this.resumed += 1; this.resumeOptions = options; return session.sessionId === "pi-worker-owned" || session.sessionId === "pi-mail"; }
  async inspectProcess(_session: PiSession, expected: PiProcessIdentity): Promise<PiProcessInspection> { return this.inspections.get(expected.pid) ?? "NOT_FOUND"; }
  async terminateProcess(_session: PiSession, expected: PiProcessIdentity): Promise<boolean> { this.terminated.push(expected.pid); return true; }
}

class UnconfirmedPi extends TestPi {
  async abort(session: PiSession): Promise<boolean> { this.aborts.push(session.sessionId); return false; }
}

class DurableProcessPi extends TestPi {
  readonly terminated: Array<{ sessionId: string; pid: number }> = [];
  async terminateProcess(session: PiSession, expected: PiProcessIdentity): Promise<boolean> {
    this.terminated.push({ sessionId: session.sessionId, pid: expected.pid });
    return true;
  }
}

class DelayedCreatePi extends TestPi {
  private resolveCreateStarted!: () => void;
  private resolveCreate!: () => void;
  readonly createStarted = new Promise<void>((resolve) => { this.resolveCreateStarted = resolve; });
  readonly createReleased = new Promise<void>((resolve) => { this.resolveCreate = resolve; });
  async createSession(sessionPath: string): Promise<PiSession> {
    this.resolveCreateStarted();
    await this.createReleased;
    return { sessionId: "pi-delayed", sessionPath };
  }
  releaseCreate(): void { this.resolveCreate(); }
}

const logger = { child: () => logger, info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger;

test("question and answer are durable before worker steer", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-home-task-"));
  const db = new SqliteStore(":memory:"); migrate(db, runtimeMigrations);
  const pi = new TestPi();
  const config = { runtime: { maxWorkers: 2, maxArtifactBytes: 100000, piCommand: "pi", piTimeoutMs: 1000 } } as AppConfig;
  const artifacts = new ArtifactService(db, root);
  const events: string[] = [];
  const tasks = new TaskService(db, pi, artifacts, config, { workerRoot: root, onEvent: async (event) => { events.push(event.type); } }, logger);
  const caps = { memory: { allowedScopes: ["global_agent"] }, projects: [{ projectId: "*", access: "WRITE" as const }], qq: { readConversations: ["c"], sendConversations: ["c"] }, plugins: { allowedActions: [] }, artifacts: { readableArtifactAuthorities: ["agent-home"], publishTaskIds: ["*"], allowedDestinations: ["c"] }, tasks: { canCreate: true, visibleTaskIds: [], canCancel: true, canFollowUp: true } };
  const task = tasks.createTask({ title: "test", goal: "ask", requester: { platform: "qq", accountId: "a", userId: "u" }, trust: "OWNER", originConversationId: "c", notificationConversationId: "c", parentCapabilities: caps });
  const worker = await tasks.createWorker({ taskId: task.id, objective: "ask", workspaceId: "project", workspaceAccess: "READ", actor: caps });
  assert.deepEqual(worker.capabilities?.memory.allowedScopes, ["global_agent"]);
  assert.equal(db.get<{ capabilities_json: string }>("SELECT capabilities_json FROM worker_executions WHERE id=?", worker.id)?.capabilities_json !== undefined, true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const question = db.get<{ id: string; status: string }>("SELECT id,status FROM pending_questions WHERE worker_id=?", worker.id);
  assert.equal(question?.status, "OPEN");
  await tasks.answerQuestion(question!.id, "staging", { conversationId: "c", message: { platform: "qq", accountId: "a", platformConversationId: "u", threadId: null, messageId: "m1" } });
  const stored = db.get<{ status: string; answer: string }>("SELECT status,answer FROM pending_questions WHERE id=?", question!.id);
  assert.equal(stored?.status, "CLOSED");
  assert.equal(stored?.answer, "staging");
  assert.equal(db.get<{ status: string }>("SELECT status FROM task_mailbox WHERE question_id=?", question!.id)?.status, "CONSUMED");
  assert.deepEqual(pi.steers, ["User answer to your blocking question: staging"]);
  assert.ok(events.includes("TASK_QUESTION"));
  await tasks.requestCancel(task.id);
  assert.equal(tasks.getTask(task.id).status, "CANCELLED");
  assert.equal(tasks.getWorker(worker.id).status, "CANCELLED");
  assert.equal(pi.aborts.length, 1);
  db.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

test("backup interruption closes stale Worker questions", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-home-task-backup-question-"));
  const db = new SqliteStore(":memory:"); migrate(db, runtimeMigrations);
  const pi = new TestPi();
  const config = { runtime: { maxWorkers: 2, maxArtifactBytes: 100000, piCommand: "pi", piTimeoutMs: 1000 } } as AppConfig;
  const artifacts = new ArtifactService(db, root);
  const tasks = new TaskService(db, pi, artifacts, config, { workerRoot: root }, logger);
  const caps = { memory: { allowedScopes: ["global_agent"] }, projects: [], qq: { readConversations: ["c"], sendConversations: ["c"] }, plugins: { allowedActions: [] }, artifacts: { readableArtifactAuthorities: ["agent-home"], publishTaskIds: ["*"], allowedDestinations: ["c"] }, tasks: { canCreate: true, visibleTaskIds: [], canCancel: true, canFollowUp: true } };
  const task = tasks.createTask({ title: "backup", goal: "question", requester: { platform: "qq", accountId: "a", userId: "u" }, trust: "OWNER", originConversationId: "c", notificationConversationId: "c", parentCapabilities: caps });
  const worker = await tasks.createWorker({ taskId: task.id, objective: "ask", actor: caps });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const question = db.get<{ id: string }>("SELECT id FROM pending_questions WHERE worker_id=?", worker.id);
  assert.ok(question);
  await tasks.quiesceForBackup();
  assert.equal(tasks.getWorker(worker.id).status, "INTERRUPTED");
  assert.equal(db.get<{ status: string }>("SELECT status FROM pending_questions WHERE id=?", question!.id)?.status, "CLOSED");
  await assert.rejects(() => tasks.answerQuestion(question!.id, "stale", { conversationId: "c", message: { platform: "qq", accountId: "a", platformConversationId: "u", threadId: null, messageId: "stale" } }), /QUESTION_NOT_OPEN/);
  db.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

test("Worker MCP bindings follow the durable Task capability lifecycle", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-home-worker-mcp-"));
  const db = new SqliteStore(":memory:"); migrate(db, runtimeMigrations);
  const registrations: Array<{ token: string; taskId: string; workerId: string; allowedActions: string[] }> = [];
  const revocations: string[] = [];
  const mcpControl = {
    registerWorkerBinding: async (binding: typeof registrations[number]) => { registrations.push(binding); return { registered: true as const }; },
    unregisterWorkerBinding: async (token: string) => { revocations.push(token); return { removed: true }; },
  } as never;
  const caps = { memory: { allowedScopes: ["global_agent"] }, projects: [], qq: { readConversations: ["c"], sendConversations: ["c"] }, plugins: { allowedActions: ["project.read"] }, artifacts: { readableArtifactAuthorities: ["agent-home"], publishTaskIds: ["*"], allowedDestinations: ["c"] }, tasks: { canCreate: true, visibleTaskIds: [], canCancel: true, canFollowUp: true } };
  const tasks = new TaskService(db, new CompletingPi(), new ArtifactService(db, root), { runtime: { maxWorkers: 1, maxArtifactBytes: 100000, piCommand: "pi", piTimeoutMs: 1000 } } as AppConfig, { workerRoot: root, mcpControl, mcpEndpoint: "http://gateway.test/mcp", workerToolExtensionPath: "/state/worker-tools.js" }, logger);
  const task = tasks.createTask({ title: "mcp", goal: "mcp", requester: { platform: "qq", accountId: "a", userId: "u" }, trust: "OWNER", originConversationId: "c", notificationConversationId: "c", parentCapabilities: caps, requestedCapabilities: { plugins: { allowedActions: ["project.read"] } } });
  const worker = await tasks.createWorker({ taskId: task.id, objective: "mcp", actor: caps });
  assert.deepEqual(worker.capabilities?.plugins.allowedActions, ["project.read"]);
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0]?.taskId, task.id);
  assert.equal(registrations[0]?.workerId, worker.id);
  assert.deepEqual(registrations[0]?.allowedActions, ["project.read"]);
  await tasks.finishWorker(worker.id, { outcome: "COMPLETED", summary: "done" });
  assert.deepEqual(revocations, [registrations[0]!.token]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  db.close(); await rm(root, { recursive: true, force: true });
});

test("task listing filters another requester in a shared conversation", () => {
  const db = new SqliteStore(":memory:"); migrate(db, runtimeMigrations);
  const root = "/tmp/agent-home-task-visibility";
  const tasks = new TaskService(db, new TestPi(), new ArtifactService(db, root), { runtime: { maxWorkers: 1, maxArtifactBytes: 1000, piCommand: "pi", piTimeoutMs: 1000 } } as AppConfig, { workerRoot: root }, logger);
  const caps = { memory: { allowedScopes: ["global_agent"] }, projects: [], qq: { readConversations: ["group"], sendConversations: ["group"] }, plugins: { allowedActions: [] }, artifacts: { readableArtifactAuthorities: ["agent-home"], publishTaskIds: [], allowedDestinations: ["group"] }, tasks: { canCreate: true, visibleTaskIds: [], canCancel: true, canFollowUp: true } };
  tasks.createTask({ title: "one", goal: "one", requester: { platform: "qq", accountId: "a", userId: "u1" }, trust: "OWNER", originConversationId: "group", notificationConversationId: "group", parentCapabilities: caps });
  tasks.createTask({ title: "two", goal: "two", requester: { platform: "qq", accountId: "a", userId: "u2" }, trust: "GUEST", originConversationId: "group", notificationConversationId: "group", parentCapabilities: caps });
  assert.deepEqual(tasks.listTasks("group", caps, "u1").map((task) => task.requester.userId), ["u1"]);
  db.close();
});

test("child Tasks require visible parent ownership and remain queryable by explicit visibility", () => {
  const db = new SqliteStore(":memory:"); migrate(db, runtimeMigrations);
  const tasks = new TaskService(db, new TestPi(), new ArtifactService(db, "/tmp/agent-home-parent-task"), { runtime: { maxWorkers: 1, maxArtifactBytes: 1000, piCommand: "pi", piTimeoutMs: 1000 } } as AppConfig, { workerRoot: "/tmp" }, logger);
  const caps = { memory: { allowedScopes: ["global_agent"] }, projects: [], qq: { readConversations: ["parent", "child"], sendConversations: ["parent", "child"] }, plugins: { allowedActions: [] }, artifacts: { readableArtifactAuthorities: ["agent-home"], publishTaskIds: ["*"], allowedDestinations: ["parent", "child"] }, tasks: { canCreate: true, visibleTaskIds: [], canCancel: true, canFollowUp: true } };
  const parent = tasks.createTask({ title: "parent", goal: "parent", requester: { platform: "qq", accountId: "a", userId: "u" }, trust: "OWNER", originConversationId: "parent", notificationConversationId: "parent", parentCapabilities: caps });
  const child = tasks.createTask({ title: "child", goal: "child", requester: { platform: "qq", accountId: "a", userId: "u" }, trust: "OWNER", originConversationId: "child", notificationConversationId: "child", parentTaskId: parent.id, parentCapabilities: caps });
  assert.equal(child.parentTaskId, parent.id);
  assert.deepEqual(new Set(tasks.listTasks("child", { ...caps, tasks: { ...caps.tasks, visibleTaskIds: [parent.id] } }, "u").map((task) => task.id)), new Set([child.id, parent.id]));
  assert.throws(() => tasks.createTask({ title: "foreign", goal: "foreign", requester: { platform: "qq", accountId: "a", userId: "other" }, trust: "OWNER", originConversationId: "child", notificationConversationId: "child", parentTaskId: parent.id, parentCapabilities: { ...caps, qq: { readConversations: ["child"], sendConversations: ["child"] } } }), /TASK_PARENT_DENIED/);
  db.close();
});

test("Task and Worker quotas apply across the deployment, project, and requester", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-home-quota-"));
  const db = new SqliteStore(":memory:"); migrate(db, runtimeMigrations);
  const config = { runtime: { maxWorkers: 2, maxWorkersTotal: 1, maxWorkersPerProject: 1, maxWorkersPerRequester: 1, maxTasks: 2, maxArtifactBytes: 100000, piCommand: "pi", piTimeoutMs: 1000 } } as AppConfig;
  const tasks = new TaskService(db, new TestPi(), new ArtifactService(db, root), config, { workerRoot: root }, logger);
  const caps = { memory: { allowedScopes: ["global_agent"] }, projects: [{ projectId: "*", access: "WRITE" as const }], qq: { readConversations: ["c"], sendConversations: ["c"] }, plugins: { allowedActions: [] }, artifacts: { readableArtifactAuthorities: ["agent-home"], publishTaskIds: ["*"], allowedDestinations: ["c"] }, tasks: { canCreate: true, visibleTaskIds: [], canCancel: true, canFollowUp: true } };
  const first = tasks.createTask({ title: "one", goal: "one", requester: { platform: "qq", accountId: "a", userId: "u" }, trust: "OWNER", originConversationId: "c", notificationConversationId: "c", parentCapabilities: caps });
  await tasks.createWorker({ taskId: first.id, objective: "one", workspaceId: "project", workspaceAccess: "WRITE", actor: caps });
  const second = tasks.createTask({ title: "two", goal: "two", requester: { platform: "qq", accountId: "a", userId: "u" }, trust: "OWNER", originConversationId: "c", notificationConversationId: "c", parentCapabilities: caps });
  await assert.rejects(() => tasks.createWorker({ taskId: second.id, objective: "two", workspaceId: "other", workspaceAccess: "WRITE", actor: caps }), /WORKER_TOTAL_QUOTA_EXCEEDED/);
  assert.throws(() => tasks.createTask({ title: "three", goal: "three", requester: { platform: "qq", accountId: "a", userId: "u" }, trust: "OWNER", originConversationId: "c", notificationConversationId: "c", parentCapabilities: caps }), /TASK_QUOTA_EXCEEDED/);
  await tasks.requestCancel(first.id);
  await new Promise((resolve) => setTimeout(resolve, 30));
  db.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

test("failed Worker attenuation does not reserve a project lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-home-worker-lock-rollback-"));
  const db = new SqliteStore(":memory:"); migrate(db, runtimeMigrations);
  const config = { runtime: { maxWorkers: 1, maxArtifactBytes: 100000, piCommand: "pi", piTimeoutMs: 1000 } } as AppConfig;
  const tasks = new TaskService(db, new TestPi(), new ArtifactService(db, root), config, { workerRoot: root }, logger);
  const caps = { memory: { allowedScopes: ["global_agent"] }, projects: [{ projectId: "project", access: "WRITE" as const }], qq: { readConversations: ["c"], sendConversations: ["c"] }, plugins: { allowedActions: [] }, artifacts: { readableArtifactAuthorities: ["agent-home"], publishTaskIds: ["*"], allowedDestinations: ["c"] }, tasks: { canCreate: true, visibleTaskIds: [], canCancel: true, canFollowUp: true } };
  const task = tasks.createTask({ title: "lock rollback", goal: "lock rollback", requester: { platform: "qq", accountId: "a", userId: "u" }, trust: "OWNER", originConversationId: "c", notificationConversationId: "c", parentCapabilities: caps });
  await assert.rejects(() => tasks.createWorker({ taskId: task.id, objective: "invalid capability", workspaceId: "project", workspaceAccess: "WRITE", requestedCapabilities: { projects: [{ projectId: "other", access: "WRITE" }] }, actor: caps }), /PRIVILEGE_ESCALATION_DENIED/);
  assert.equal(db.get("SELECT 1 FROM project_locks WHERE project_id='project'"), undefined);
  db.close(); await rm(root, { recursive: true, force: true });
});

test("a second writer is queued behind the durable project lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-home-lock-"));
  const db = new SqliteStore(":memory:"); migrate(db, runtimeMigrations);
  const config = { runtime: { maxWorkers: 2, maxArtifactBytes: 100000, piCommand: "pi", piTimeoutMs: 1000 } } as AppConfig;
  const tasks = new TaskService(db, new TestPi(), new ArtifactService(db, root), config, { workerRoot: root, onEvent: async () => {} }, logger);
  const caps = { memory: { allowedScopes: ["global_agent"] }, projects: [{ projectId: "*", access: "WRITE" as const }], qq: { readConversations: ["c"], sendConversations: ["c"] }, plugins: { allowedActions: [] }, artifacts: { readableArtifactAuthorities: ["agent-home"], publishTaskIds: ["*"], allowedDestinations: ["c"] }, tasks: { canCreate: true, visibleTaskIds: [], canCancel: true, canFollowUp: true } };
  const task = tasks.createTask({ title: "lock", goal: "lock", requester: { platform: "qq", accountId: "a", userId: "u" }, trust: "OWNER", originConversationId: "c", notificationConversationId: "c", parentCapabilities: caps });
  const first = await tasks.createWorker({ taskId: task.id, objective: "one", workspaceId: "project", workspaceAccess: "WRITE", actor: caps });
  const second = await tasks.createWorker({ taskId: task.id, objective: "two", workspaceId: "project", workspaceAccess: "WRITE", actor: caps });
  assert.equal(first.status, "STARTING"); assert.equal(second.status, "PENDING");
  assert.equal(db.get<{ owner_worker_id: string }>("SELECT owner_worker_id FROM project_locks WHERE project_id='project'")?.owner_worker_id, first.id);
  await new Promise((resolve) => setTimeout(resolve, 20));
  db.close(); await rm(root, { recursive: true, force: true });
});

test("pending writer starts after the previous writer releases its lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-home-scheduler-"));
  const db = new SqliteStore(":memory:"); migrate(db, runtimeMigrations);
  const config = { runtime: { maxWorkers: 2, maxArtifactBytes: 100000, piCommand: "pi", piTimeoutMs: 1000 } } as AppConfig;
  const tasks = new TaskService(db, new CompletingPi(), new ArtifactService(db, root), config, { workerRoot: root, onEvent: async () => {} }, logger);
  const caps = { memory: { allowedScopes: ["global_agent"] }, projects: [{ projectId: "*", access: "WRITE" as const }], qq: { readConversations: ["c"], sendConversations: ["c"] }, plugins: { allowedActions: [] }, artifacts: { readableArtifactAuthorities: ["agent-home"], publishTaskIds: ["*"], allowedDestinations: ["c"] }, tasks: { canCreate: true, visibleTaskIds: [], canCancel: true, canFollowUp: true } };
  const task = tasks.createTask({ title: "queue", goal: "queue", requester: { platform: "qq", accountId: "a", userId: "u" }, trust: "OWNER", originConversationId: "c", notificationConversationId: "c", parentCapabilities: caps });
  const first = await tasks.createWorker({ taskId: task.id, objective: "one", workspaceId: "project", workspaceAccess: "WRITE", actor: caps });
  const second = await tasks.createWorker({ taskId: task.id, objective: "two", workspaceId: "project", workspaceAccess: "WRITE", actor: caps });
  assert.equal(second.status, "PENDING");
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(tasks.getWorker(first.id).status, "COMPLETED");
  assert.equal(tasks.getWorker(second.id).status, "COMPLETED");
  assert.equal(tasks.getTask(task.id).status, "RUNNING");
  await tasks.finishTask(task.id, { outcome: "COMPLETED", summary: "both workers verified" });
  assert.equal(tasks.getTask(task.id).status, "COMPLETED");
  db.close(); await rm(root, { recursive: true, force: true });
});

test("runtime recovery does not leave phantom RUNNING workers", async () => {
  const db = new SqliteStore(":memory:"); migrate(db, runtimeMigrations);
  const timestamp = new Date().toISOString();
  db.run("INSERT INTO tasks(id,title,goal,status,requester_json,trust,origin_conversation_id,notification_conversation_id,capabilities_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)", "t", "x", "x", "RUNNING", JSON.stringify({}), "OWNER", "c", "c", JSON.stringify({ tasks: { canCancel: true } }), timestamp, timestamp);
  db.run("INSERT INTO worker_executions(id,task_id,objective,status,harness,updated_at) VALUES (?,?,?,?,?,?)", "w", "t", "x", "RUNNING", "pi", timestamp);
  const config = { runtime: { maxWorkers: 2, maxArtifactBytes: 100000, piCommand: "pi", piTimeoutMs: 1000 } } as AppConfig;
  const tasks = new TaskService(db, new TestPi(), new ArtifactService(db, "/tmp"), config, { workerRoot: "/tmp", onEvent: async () => {} }, logger);
  await tasks.recover();
  assert.equal(db.get<{ status: string }>("SELECT status FROM worker_executions WHERE id='w'")?.status, "INTERRUPTED");
  assert.equal(db.get<{ status: string }>("SELECT status FROM tasks WHERE id='t'")?.status, "INTERRUPTED");
  db.close();
});

test("WorkerControl persists progress, publishes artifacts, and explicitly finishes", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-home-control-"));
  const db = new SqliteStore(":memory:"); migrate(db, runtimeMigrations);
  const config = { runtime: { maxWorkers: 2, maxArtifactBytes: 100000, piCommand: "pi", piTimeoutMs: 1000 } } as AppConfig;
  const events: string[] = [];
  const tasks = new TaskService(db, new StructuredPi(), new ArtifactService(db, root), config, { workerRoot: root, onEvent: async (event) => { events.push(event.type); } }, logger);
  const caps = { memory: { allowedScopes: ["global_agent"] }, projects: [{ projectId: "*", access: "WRITE" as const }], qq: { readConversations: ["c"], sendConversations: ["c"] }, plugins: { allowedActions: [] }, artifacts: { readableArtifactAuthorities: ["agent-home"], publishTaskIds: ["*"], allowedDestinations: ["c"] }, tasks: { canCreate: true, visibleTaskIds: [], canCancel: true, canFollowUp: true } };
  const task = tasks.createTask({ title: "control", goal: "control", requester: { platform: "qq", accountId: "a", userId: "u" }, trust: "OWNER", originConversationId: "c", notificationConversationId: "c", parentCapabilities: caps });
  const worker = await tasks.createWorker({ taskId: task.id, objective: "control", workspaceId: "project", workspaceAccess: "WRITE", actor: caps });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(tasks.getWorker(worker.id).status, "COMPLETED");
  assert.equal(tasks.getTask(task.id).status, "RUNNING");
  assert.equal(db.get<{ count: number }>("SELECT count(*) AS count FROM task_events WHERE task_id=? AND type='WORKER_PROGRESS'", task.id)?.count, 1);
  const artifact = db.get<{ owner_task_id: string; producer_worker_id: string; status: string }>("SELECT owner_task_id,producer_worker_id,status FROM artifacts WHERE owner_task_id=?", task.id);
  assert.equal(artifact?.owner_task_id, task.id);
  assert.equal(artifact?.producer_worker_id, worker.id);
  assert.equal(artifact?.status, "AVAILABLE");
  await tasks.finishTask(task.id, { outcome: "COMPLETED", summary: "confirmed" });
  assert.equal(tasks.getTask(task.id).status, "COMPLETED");
  db.close(); await rm(root, { recursive: true, force: true });
});

test("recovery verifies process ownership before termination and preserves unknown locks", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-home-recovery-"));
  const db = new SqliteStore(":memory:"); migrate(db, runtimeMigrations);
  const pi = new RecoveryPi(); pi.inspections.set(101, "OWNED"); pi.inspections.set(202, "NOT_FOUND"); pi.inspections.set(303, "FOREIGN");
  const config = { runtime: { maxWorkers: 2, maxArtifactBytes: 100000, piCommand: "pi", piTimeoutMs: 1000 } } as AppConfig;
  const tasks = new TaskService(db, pi, new ArtifactService(db, root), config, { workerRoot: root, onEvent: async () => {} }, logger);
  const timestamp = new Date().toISOString();
  const caps = { memory: { allowedScopes: ["global_agent"] }, projects: [{ projectId: "project", access: "WRITE" as const }], qq: { readConversations: [], sendConversations: [] }, plugins: { allowedActions: [] }, artifacts: { readableArtifactAuthorities: [], publishTaskIds: [], allowedDestinations: [] }, tasks: { canCreate: false, visibleTaskIds: [], canCancel: true, canFollowUp: true } };
  const insert = (taskId: string, workerId: string, pid: number, status: string, projectId: string) => {
    db.run("INSERT INTO tasks(id,title,goal,status,requester_json,trust,origin_conversation_id,notification_conversation_id,capabilities_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)", taskId, taskId, taskId, "RUNNING", JSON.stringify({ platform: "qq", accountId: "a", userId: "u" }), "OWNER", "c", "c", JSON.stringify(caps), timestamp, timestamp);
    db.run("INSERT INTO worker_executions(id,task_id,objective,status,harness,harness_session_id,workspace_id,workspace_access,process_id,capabilities_json,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)", workerId, taskId, "recover", status, "pi", `pi-${workerId}`, projectId, "WRITE", pid, JSON.stringify(caps), timestamp);
    db.run("INSERT INTO owned_processes(id,task_id,worker_id,pid,process_group_id,command_summary,started_at,pid_start_time) VALUES (?,?,?,?,?,?,?,?)", `process-${workerId}`, taskId, workerId, pid, pid, "pi --mode rpc --session", timestamp, "boot");
    db.run("INSERT INTO project_locks(project_id,mode,owner_worker_id,acquired_at) VALUES (?,?,?,?)", projectId, "WRITE", workerId, timestamp);
  };
  insert("task-owned", "worker-owned", 101, "RUNNING", "project-owned");
  insert("task-stale", "worker-stale", 202, "RUNNING", "project-stale");
  insert("task-foreign", "worker-foreign", 303, "RUNNING", "project-foreign");
  insert("task-terminal", "worker-terminal", 404, "COMPLETED", "project-terminal");
  await tasks.recover();
  assert.deepEqual(pi.terminated, [101]);
  assert.equal(tasks.getWorker("worker-owned").status, "RUNNING");
  assert.equal(tasks.getWorker("worker-stale").status, "INTERRUPTED");
  assert.equal(tasks.getWorker("worker-foreign").status, "INTERRUPTED");
  assert.ok(db.get("SELECT 1 FROM project_locks WHERE project_id='project-owned'"));
  assert.equal(db.get("SELECT 1 FROM project_locks WHERE project_id='project-stale'"), undefined);
  assert.ok(db.get("SELECT 1 FROM project_locks WHERE project_id='project-foreign'"));
  assert.equal(db.get("SELECT 1 FROM project_locks WHERE project_id='project-terminal'"), undefined);
  assert.ok(db.get("SELECT 1 FROM runtime_exceptions WHERE worker_id='worker-foreign' AND category='PROCESS_STATE_UNKNOWN'"));
  db.close(); await rm(root, { recursive: true, force: true });
});

test("recovery resumes a question session and replays its pending mailbox", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-home-mailbox-recovery-"));
  const db = new SqliteStore(":memory:"); migrate(db, runtimeMigrations);
  const pi = new RecoveryPi();
  const config = { runtime: { maxWorkers: 2, maxArtifactBytes: 100000, piCommand: "pi", piTimeoutMs: 1000 } } as AppConfig;
  const tasks = new TaskService(db, pi, new ArtifactService(db, root), config, { workerRoot: root, onEvent: async () => {} }, logger);
  const timestamp = new Date().toISOString();
  const caps = { memory: { allowedScopes: ["global_agent"] }, projects: [], qq: { readConversations: [], sendConversations: [] }, plugins: { allowedActions: [] }, artifacts: { readableArtifactAuthorities: [], publishTaskIds: [], allowedDestinations: [] }, tasks: { canCreate: false, visibleTaskIds: [], canCancel: true, canFollowUp: true } };
  db.run("INSERT INTO tasks(id,title,goal,status,requester_json,trust,origin_conversation_id,notification_conversation_id,capabilities_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)", "task-mail", "mail", "mail", "WAITING_USER", JSON.stringify({}), "OWNER", "c", "c", JSON.stringify(caps), timestamp, timestamp);
  db.run("INSERT INTO worker_executions(id,task_id,objective,status,harness,harness_session_id,updated_at,capabilities_json) VALUES (?,?,?,?,?,?,?,?)", "worker-mail", "task-mail", "mail", "WAITING_USER", "pi", "pi-mail", timestamp, JSON.stringify(caps));
  db.run("INSERT INTO pending_questions(id,task_id,worker_id,question,status,answer,created_at,answered_at) VALUES (?,?,?,?,?,?,?,?)", "question-mail", "task-mail", "worker-mail", "Which environment?", "ANSWERED", "staging", timestamp, timestamp);
  db.run("INSERT INTO task_mailbox(id,task_id,type,source_conversation_id,source_message_key,content,status,created_at,worker_id,question_id) VALUES (?,?,?,?,?,?,?,?,?,?)", "mail-1", "task-mail", "FOLLOW_UP", "c", "message", "staging", "PENDING", timestamp, "worker-mail", "question-mail");
  await tasks.recover();
  assert.equal(pi.resumed, 1);
  assert.equal(pi.resumeOptions?.sandbox?.workspaceRoot, join(root, "scratch", "worker-mail"));
  assert.equal(db.get<{ status: string }>("SELECT status FROM task_mailbox WHERE id='mail-1'")?.status, "CONSUMED");
  assert.equal(db.get<{ status: string }>("SELECT status FROM pending_questions WHERE id='question-mail'")?.status, "CLOSED");
  assert.equal(tasks.getWorker("worker-mail").status, "RUNNING");
  assert.equal(tasks.getTask("task-mail").status, "RUNNING");
  db.close(); await rm(root, { recursive: true, force: true });
});

test("cancellation stays STOPPING when process termination is not confirmed", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-home-cancel-"));
  const db = new SqliteStore(":memory:"); migrate(db, runtimeMigrations);
  const pi = new UnconfirmedPi();
  const config = { runtime: { maxWorkers: 2, maxArtifactBytes: 100000, piCommand: "pi", piTimeoutMs: 1000 } } as AppConfig;
  const tasks = new TaskService(db, pi, new ArtifactService(db, root), config, { workerRoot: root, onEvent: async () => {} }, logger);
  const caps = { memory: { allowedScopes: ["global_agent"] }, projects: [], qq: { readConversations: ["c"], sendConversations: ["c"] }, plugins: { allowedActions: [] }, artifacts: { readableArtifactAuthorities: ["agent-home"], publishTaskIds: ["*"], allowedDestinations: ["c"] }, tasks: { canCreate: true, visibleTaskIds: [], canCancel: true, canFollowUp: true } };
  const task = tasks.createTask({ title: "cancel", goal: "cancel", requester: { platform: "qq", accountId: "a", userId: "u" }, trust: "OWNER", originConversationId: "c", notificationConversationId: "c", parentCapabilities: caps });
  const worker = await tasks.createWorker({ taskId: task.id, objective: "cancel", workspaceAccess: "READ", actor: caps });
  await new Promise((resolve) => setTimeout(resolve, 20));
  db.run("INSERT INTO pending_questions(id,task_id,worker_id,question,status,created_at) VALUES (?,?,?,?,?,?)", "cancel-question", task.id, worker.id, "cancel me?", "OPEN", new Date().toISOString());
  await tasks.requestCancel(task.id);
  assert.equal(tasks.getWorker(worker.id).status, "STOPPING");
  assert.notEqual(tasks.getTask(task.id).status, "CANCELLED");
  assert.equal(db.get<{ status: string }>("SELECT status FROM pending_questions WHERE id='cancel-question'")?.status, "CLOSED");
  assert.ok(db.get("SELECT 1 FROM runtime_exceptions WHERE task_id=? AND category='PROCESS_STATE_UNKNOWN'", task.id));
  db.close(); await rm(root, { recursive: true, force: true });
});

test("cancellation linearizes before a delayed Worker startup", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-home-cancel-starting-"));
  const db = new SqliteStore(":memory:"); migrate(db, runtimeMigrations);
  const pi = new DelayedCreatePi();
  const config = { runtime: { maxWorkers: 1, maxArtifactBytes: 100000, piCommand: "pi", piTimeoutMs: 1000 } } as AppConfig;
  const tasks = new TaskService(db, pi, new ArtifactService(db, root), config, { workerRoot: root }, logger);
  const caps = { memory: { allowedScopes: ["global_agent"] }, projects: [], qq: { readConversations: ["c"], sendConversations: ["c"] }, plugins: { allowedActions: [] }, artifacts: { readableArtifactAuthorities: ["agent-home"], publishTaskIds: ["*"], allowedDestinations: ["c"] }, tasks: { canCreate: true, visibleTaskIds: [], canCancel: true, canFollowUp: true } };
  const task = tasks.createTask({ title: "race", goal: "race", requester: { platform: "qq", accountId: "a", userId: "u" }, trust: "OWNER", originConversationId: "c", notificationConversationId: "c", parentCapabilities: caps });
  const worker = await tasks.createWorker({ taskId: task.id, objective: "race", workspaceAccess: "READ", actor: caps });
  await pi.createStarted;
  await tasks.requestCancel(task.id);
  assert.equal(tasks.getWorker(worker.id).status, "CANCELLED");
  pi.releaseCreate();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(tasks.getWorker(worker.id).status, "CANCELLED");
  assert.deepEqual(pi.aborts, ["pi-delayed"]);
  db.close(); await rm(root, { recursive: true, force: true });
});

test("cancellation terminates a durable Worker process without an in-memory session", async () => {
  const db = new SqliteStore(":memory:"); migrate(db, runtimeMigrations);
  const pi = new DurableProcessPi();
  const config = { runtime: { maxWorkers: 1, maxArtifactBytes: 100000, piCommand: "pi", piTimeoutMs: 1000 } } as AppConfig;
  const tasks = new TaskService(db, pi, new ArtifactService(db, "/tmp"), config, { workerRoot: "/tmp/agent-home-durable-stop" }, logger);
  const caps = { memory: { allowedScopes: ["global_agent"] }, projects: [], qq: { readConversations: ["c"], sendConversations: ["c"] }, plugins: { allowedActions: [] }, artifacts: { readableArtifactAuthorities: ["agent-home"], publishTaskIds: ["*"], allowedDestinations: ["c"] }, tasks: { canCreate: true, visibleTaskIds: [], canCancel: true, canFollowUp: true } };
  const task = tasks.createTask({ title: "durable stop", goal: "durable stop", requester: { platform: "qq", accountId: "a", userId: "u" }, trust: "OWNER", originConversationId: "c", notificationConversationId: "c", parentCapabilities: caps });
  const timestamp = new Date().toISOString();
  db.run("INSERT INTO worker_executions(id,task_id,objective,status,harness,harness_session_id,harness_session_path,workspace_id,process_id,capabilities_json,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)", "worker-durable", task.id, "stop", "RUNNING", "pi", "pi-durable", "/tmp/agent-home-durable-stop/sessions/worker-durable/session.jsonl", "project", 321, JSON.stringify(caps), timestamp);
  db.run("INSERT INTO owned_processes(id,task_id,worker_id,pid,process_group_id,command_summary,started_at,pid_start_time) VALUES (?,?,?,?,?,?,?,?)", "process-worker-durable", task.id, "worker-durable", 321, 654, "pi --mode rpc --session", timestamp, "start-321");
  db.run("INSERT INTO project_locks(project_id,mode,owner_worker_id,acquired_at) VALUES (?,?,?,?)", "project", "WRITE", "worker-durable", timestamp);
  await tasks.requestCancel(task.id);
  assert.deepEqual(pi.terminated, [{ sessionId: "pi-durable", pid: 321 }]);
  assert.equal(tasks.getWorker("worker-durable").status, "CANCELLED");
  assert.equal(tasks.getTask(task.id).status, "CANCELLED");
  assert.equal(db.get("SELECT 1 FROM owned_processes WHERE worker_id='worker-durable'"), undefined);
  assert.equal(db.get("SELECT 1 FROM project_locks WHERE owner_worker_id='worker-durable'"), undefined);
  db.close();
});

test("terminal Tasks reject Worker creation, follow-up, and cancellation", async () => {
  const db = new SqliteStore(":memory:"); migrate(db, runtimeMigrations);
  const config = { runtime: { maxWorkers: 1, maxArtifactBytes: 100000, piCommand: "pi", piTimeoutMs: 1000 } } as AppConfig;
  const tasks = new TaskService(db, new TestPi(), new ArtifactService(db, "/tmp"), config, { workerRoot: "/tmp" }, logger);
  const caps = { memory: { allowedScopes: ["global_agent"] }, projects: [], qq: { readConversations: ["c"], sendConversations: ["c"] }, plugins: { allowedActions: [] }, artifacts: { readableArtifactAuthorities: ["agent-home"], publishTaskIds: ["*"], allowedDestinations: ["c"] }, tasks: { canCreate: true, visibleTaskIds: [], canCancel: true, canFollowUp: true } };
  const task = tasks.createTask({ title: "terminal", goal: "terminal", requester: { platform: "qq", accountId: "a", userId: "u" }, trust: "OWNER", originConversationId: "c", notificationConversationId: "c", parentCapabilities: caps });
  await tasks.finishTask(task.id, { outcome: "COMPLETED", summary: "done" });
  await assert.rejects(() => tasks.createWorker({ taskId: task.id, objective: "late", actor: caps }), /TASK_CREATE_WORKER_DENIED/);
  await assert.rejects(() => tasks.addFollowUp(task.id, "late", { conversationId: "c", message: { platform: "qq", accountId: "a", platformConversationId: "u", threadId: null, messageId: "late" } }), /TASK_FOLLOW_UP_DENIED/);
  await assert.rejects(() => tasks.requestCancel(task.id), /TASK_CANCEL_DENIED/);
  db.close();
});

test("TaskService rejects forged group capability and malformed durable capability JSON", () => {
  const db = new SqliteStore(":memory:"); migrate(db, runtimeMigrations);
  const timestamp = new Date().toISOString();
  db.run("INSERT INTO conversations(conversation_id,platform,account_id,kind,platform_conversation_id,thread_id_json,trust,memory_scopes_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)", "group-conv", "qq", "a", "group", "g", "null", "GUEST", JSON.stringify(["global_agent", "group:group-conv"]), timestamp, timestamp);
  db.run("INSERT INTO tasks(id,title,goal,status,requester_json,trust,origin_conversation_id,notification_conversation_id,capabilities_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)", "bad-task", "bad", "bad", "CREATED", JSON.stringify({}), "OWNER", "group-conv", "group-conv", "{}", timestamp, timestamp);
  const config = { owner: { platform: "qq", accountId: "a", userId: "owner" }, runtime: { maxWorkers: 1, maxArtifactBytes: 100000, piCommand: "pi", piTimeoutMs: 1000 } } as AppConfig;
  const tasks = new TaskService(db, new TestPi(), new ArtifactService(db, "/tmp"), config, { workerRoot: "/tmp", onEvent: async () => {} }, logger);
  const forged = { memory: { allowedScopes: ["global_agent", "group:group-conv"] }, projects: [{ projectId: "*", access: "WRITE" as const }], qq: { readConversations: ["group-conv"], sendConversations: ["group-conv"] }, plugins: { allowedActions: [] }, artifacts: { readableArtifactAuthorities: ["agent-home"], publishTaskIds: [], allowedDestinations: ["group-conv"] }, tasks: { canCreate: true, visibleTaskIds: [], canCancel: true, canFollowUp: true } };
  assert.throws(() => tasks.createTask({ title: "forged", goal: "forged", requester: { platform: "qq", accountId: "a", userId: "owner" }, trust: "OWNER", originConversationId: "group-conv", notificationConversationId: "group-conv", parentCapabilities: forged }), /CAPABILITY_CONTEXT_INVALID/);
  assert.throws(() => tasks.getTask("bad-task"), /CAPABILITY_SNAPSHOT_INVALID/);
  db.close();
});

test("Task notification destinations and workspace IDs are bounded", async () => {
  const db = new SqliteStore(":memory:"); migrate(db, runtimeMigrations);
  const config = { runtime: { maxWorkers: 1, maxArtifactBytes: 100000, piCommand: "pi", piTimeoutMs: 1000 } } as AppConfig;
  const tasks = new TaskService(db, new TestPi(), new ArtifactService(db, "/tmp"), config, { workerRoot: "/tmp", onEvent: async () => {} }, logger);
  const caps = { memory: { allowedScopes: ["global_agent"] }, projects: [], qq: { readConversations: ["allowed"], sendConversations: ["allowed"] }, plugins: { allowedActions: [] }, artifacts: { readableArtifactAuthorities: ["agent-home"], publishTaskIds: ["*"], allowedDestinations: ["allowed"] }, tasks: { canCreate: true, visibleTaskIds: [], canCancel: true, canFollowUp: true } };
  assert.throws(() => tasks.createTask({ title: "denied", goal: "denied", requester: { platform: "qq", accountId: "a", userId: "u" }, trust: "OWNER", originConversationId: "allowed", notificationConversationId: "foreign", parentCapabilities: caps }), /TASK_NOTIFICATION_DENIED/);
  const task = tasks.createTask({ title: "bounded", goal: "bounded", requester: { platform: "qq", accountId: "a", userId: "u" }, trust: "OWNER", originConversationId: "allowed", notificationConversationId: "allowed", parentCapabilities: { ...caps, projects: [{ projectId: "*", access: "WRITE" as const }] } });
  await assert.rejects(() => tasks.createWorker({ taskId: task.id, objective: "escape", workspaceId: "../escape", workspaceAccess: "WRITE", actor: { ...caps, projects: [{ projectId: "*", access: "WRITE" as const }] } }), /WORKSPACE_ID_INVALID/);
  db.close();
});

test("normal Worker startup rejects a tampered durable workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-home-tampered-workspace-"));
  const db = new SqliteStore(":memory:"); migrate(db, runtimeMigrations);
  const tasks = new TaskService(db, new TestPi(), new ArtifactService(db, root), { runtime: { maxWorkers: 1, maxArtifactBytes: 100000, piCommand: "pi", piTimeoutMs: 1000 } } as AppConfig, { workerRoot: root, onEvent: async () => {} }, logger);
  const timestamp = new Date().toISOString();
  const caps = { memory: { allowedScopes: ["global_agent"] }, projects: [{ projectId: "*", access: "WRITE" as const }], qq: { readConversations: ["allowed"], sendConversations: ["allowed"] }, plugins: { allowedActions: [] }, artifacts: { readableArtifactAuthorities: ["agent-home"], publishTaskIds: ["*"], allowedDestinations: ["allowed"] }, tasks: { canCreate: true, visibleTaskIds: [], canCancel: true, canFollowUp: true } };
  const task = tasks.createTask({ title: "tampered", goal: "tampered", requester: { platform: "qq", accountId: "a", userId: "u" }, trust: "OWNER", originConversationId: "allowed", notificationConversationId: "allowed", parentCapabilities: caps });
  db.run("INSERT INTO worker_executions(id,task_id,objective,status,harness,workspace_id,workspace_access,capabilities_json,updated_at) VALUES (?,?,?,?,?,?,?,?,?)", "worker-tampered", task.id, "tampered", "STARTING", "pi", "../escape", "WRITE", JSON.stringify(caps), timestamp);
  try {
    await assert.rejects(() => tasks.startWorker("worker-tampered"), /WORKSPACE_ID_INVALID/);
  } finally {
    db.close(); await rm(root, { recursive: true, force: true });
  }
});
