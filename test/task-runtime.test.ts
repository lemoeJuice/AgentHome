import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore, migrate } from "../src/db.js";
import { runtimeMigrations } from "../src/schema.js";
import { TaskService } from "../src/runtime/tasks.js";
import { ArtifactService } from "../src/runtime/artifacts.js";
import type { PiHarness, PiSession } from "../src/runtime/pi.js";
import type { AppConfig } from "../src/config.js";
import type { Logger } from "../src/shared/logger.js";

class TestPi implements PiHarness {
  readonly steers: string[] = [];
  readonly aborts: string[] = [];
  async createSession(sessionPath: string): Promise<PiSession> { return { sessionId: `pi-${this.steers.length}`, sessionPath }; }
  async resumeSession(): Promise<boolean> { return true; }
  async send(): Promise<string> { return JSON.stringify({ type: "question", question: "Which environment?" }); }
  async steer(_session: PiSession, prompt: string): Promise<string> { this.steers.push(prompt); return "continued"; }
  async abort(session: PiSession): Promise<boolean> { this.aborts.push(session.sessionId); return true; }
  async inspect(): Promise<"available" | "missing" | "unknown"> { return "available"; }
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
  const caps = { memory: { allowedScopes: ["global_agent"] }, projects: [{ projectId: "*", access: "WRITE" as const }], qq: { readConversations: ["c"], sendConversations: ["c"] }, plugins: { allowedActions: [] }, artifacts: { publishTaskIds: [], allowedDestinations: ["c"] }, tasks: { canCreate: true, visibleTaskIds: [], canCancel: true, canFollowUp: true } };
  const task = tasks.createTask({ title: "test", goal: "ask", requester: { platform: "qq", accountId: "a", userId: "u" }, trust: "OWNER", originConversationId: "c", notificationConversationId: "c", parentCapabilities: caps });
  const worker = await tasks.createWorker({ taskId: task.id, objective: "ask", workspaceId: "project", workspaceAccess: "READ" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const question = db.get<{ id: string; status: string }>("SELECT id,status FROM pending_questions WHERE worker_id=?", worker.id);
  assert.equal(question?.status, "OPEN");
  await tasks.answerQuestion(question!.id, "staging", { conversationId: "c", message: { platform: "qq", accountId: "a", platformConversationId: "u", threadId: null, messageId: "m1" } });
  const stored = db.get<{ status: string; answer: string }>("SELECT status,answer FROM pending_questions WHERE id=?", question!.id);
  assert.equal(stored?.status, "CLOSED");
  assert.equal(stored?.answer, "staging");
  assert.deepEqual(pi.steers, ["User answer to your blocking question: staging"]);
  assert.ok(events.includes("TASK_QUESTION"));
  await tasks.requestCancel(task.id);
  assert.equal(tasks.getTask(task.id).status, "CANCELLED");
  assert.equal(pi.aborts.length, 1);
  db.close(); await rm(root, { recursive: true, force: true });
});

test("a second writer is queued behind the durable project lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-home-lock-"));
  const db = new SqliteStore(":memory:"); migrate(db, runtimeMigrations);
  const config = { runtime: { maxWorkers: 2, maxArtifactBytes: 100000, piCommand: "pi", piTimeoutMs: 1000 } } as AppConfig;
  const tasks = new TaskService(db, new TestPi(), new ArtifactService(db, root), config, { workerRoot: root, onEvent: async () => {} }, logger);
  const caps = { memory: { allowedScopes: ["global_agent"] }, projects: [{ projectId: "*", access: "WRITE" as const }], qq: { readConversations: ["c"], sendConversations: ["c"] }, plugins: { allowedActions: [] }, artifacts: { publishTaskIds: [], allowedDestinations: ["c"] }, tasks: { canCreate: true, visibleTaskIds: [], canCancel: true, canFollowUp: true } };
  const task = tasks.createTask({ title: "lock", goal: "lock", requester: { platform: "qq", accountId: "a", userId: "u" }, trust: "OWNER", originConversationId: "c", notificationConversationId: "c", parentCapabilities: caps });
  const first = await tasks.createWorker({ taskId: task.id, objective: "one", workspaceId: "project", workspaceAccess: "WRITE" });
  const second = await tasks.createWorker({ taskId: task.id, objective: "two", workspaceId: "project", workspaceAccess: "WRITE" });
  assert.equal(first.status, "STARTING"); assert.equal(second.status, "PENDING");
  assert.equal(db.get<{ owner_worker_id: string }>("SELECT owner_worker_id FROM project_locks WHERE project_id='project'")?.owner_worker_id, first.id);
  await new Promise((resolve) => setTimeout(resolve, 20));
  db.close(); await rm(root, { recursive: true, force: true });
});

test("runtime recovery does not leave phantom RUNNING workers", () => {
  const db = new SqliteStore(":memory:"); migrate(db, runtimeMigrations);
  const timestamp = new Date().toISOString();
  db.run("INSERT INTO tasks(id,title,goal,status,requester_json,trust,origin_conversation_id,notification_conversation_id,capabilities_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)", "t", "x", "x", "RUNNING", JSON.stringify({}), "OWNER", "c", "c", JSON.stringify({ tasks: { canCancel: true } }), timestamp, timestamp);
  db.run("INSERT INTO worker_executions(id,task_id,objective,status,harness,updated_at) VALUES (?,?,?,?,?,?)", "w", "t", "x", "RUNNING", "pi", timestamp);
  const config = { runtime: { maxWorkers: 2, maxArtifactBytes: 100000, piCommand: "pi", piTimeoutMs: 1000 } } as AppConfig;
  const tasks = new TaskService(db, new TestPi(), new ArtifactService(db, "/tmp"), config, { workerRoot: "/tmp", onEvent: async () => {} }, logger);
  tasks.recover();
  assert.equal(db.get<{ status: string }>("SELECT status FROM worker_executions WHERE id='w'")?.status, "INTERRUPTED");
  assert.equal(db.get<{ status: string }>("SELECT status FROM tasks WHERE id='t'")?.status, "INTERRUPTED");
  db.close();
});
