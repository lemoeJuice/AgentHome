import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { AppConfig } from "../config.js";
import type { SqliteStore } from "../db.js";
import { attenuateTask, attenuateWorker, type AuthorizationDecision, authorizeSend } from "../auth.js";
import { newId, nowIso, messageKey } from "../shared/ids.js";
import type { CapabilitySet, PlatformMessageRef, TaskRecord, TaskRequester, TaskStatus, WorkerExecutionRecord, WorkerStatus } from "../shared/types.js";
import type { ArtifactService } from "./artifacts.js";
import type { PiHarness, PiSession } from "./pi.js";
import type { Logger } from "../shared/logger.js";

export type RuntimeEvent = { type: string; taskId?: string; workerId?: string; questionId?: string; payload?: Record<string, unknown> };

export interface TaskServiceOptions {
  onEvent?: (event: RuntimeEvent, task: TaskRecord) => Promise<void>;
  workerRoot: string;
}

export class TaskService {
  private readonly db: SqliteStore;
  private readonly pi: PiHarness;
  private readonly artifacts: ArtifactService;
  private readonly config: AppConfig;
  private readonly options: TaskServiceOptions;
  private readonly activeSessions = new Map<string, PiSession>();
  private readonly log: Logger;

  constructor(db: SqliteStore, pi: PiHarness, artifacts: ArtifactService, config: AppConfig, options: TaskServiceOptions, logger: Logger) {
    this.db = db; this.pi = pi; this.artifacts = artifacts; this.config = config; this.options = options;
    this.log = logger.child("tasks");
  }

  createTask(input: { title: string; goal: string; requester: TaskRequester; trust: "OWNER" | "GUEST"; originConversationId: string; notificationConversationId: string; parentTaskId?: string; parentCapabilities: CapabilitySet; requestedCapabilities?: Partial<CapabilitySet> }): TaskRecord {
    if (!input.parentCapabilities.tasks.canCreate) throw new Error("TASK_CREATE_DENIED");
    const id = newId("task");
    const capabilities = attenuateTask(input.parentCapabilities, input.requestedCapabilities ?? {}, id);
    const timestamp = nowIso();
    const task: TaskRecord = { id, title: input.title, goal: input.goal, status: "CREATED", requester: input.requester, trust: input.trust, originConversationId: input.originConversationId, notificationConversationId: input.notificationConversationId, ...(input.parentTaskId ? { parentTaskId: input.parentTaskId } : {}), capabilities, createdAt: timestamp, updatedAt: timestamp };
    this.db.transaction(() => {
      this.db.run("INSERT INTO tasks(id,title,goal,status,requester_json,trust,origin_conversation_id,notification_conversation_id,parent_task_id,capabilities_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", id, task.title, task.goal, task.status, JSON.stringify(task.requester), task.trust, task.originConversationId, task.notificationConversationId, task.parentTaskId ?? null, JSON.stringify(task.capabilities), timestamp, timestamp);
      this.event(id, "TASK_CREATED", undefined, { title: task.title });
    });
    return task;
  }

  async createWorker(input: { taskId: string; objective: string; workspaceId?: string; workspaceAccess?: "READ" | "WRITE"; requestedCapabilities?: Partial<CapabilitySet> }): Promise<WorkerExecutionRecord> {
    const task = this.getTask(input.taskId);
    const workerCount = Number(this.db.get<{ count: number }>("SELECT count(*) AS count FROM worker_executions WHERE task_id=? AND status IN ('PENDING','STARTING','RUNNING','WAITING_USER','STOPPING')", input.taskId)?.count ?? 0);
    if (workerCount >= this.config.runtime.maxWorkers) throw new Error("WORKER_QUOTA_EXCEEDED");
    const workerId = newId("worker");
    const status: WorkerStatus = input.workspaceAccess === "WRITE" && input.workspaceId && !this.tryAcquireLock(input.workspaceId, workerId) ? "PENDING" : "STARTING";
    const timestamp = nowIso();
    const worker: WorkerExecutionRecord = { id: workerId, taskId: input.taskId, objective: input.objective, status, harness: "pi", ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}), ...(input.workspaceAccess ? { workspaceAccess: input.workspaceAccess } : {}), updatedAt: timestamp };
    // Capability attenuation is intentionally computed and validated at the service boundary.
    attenuateWorker(task.capabilities, input.requestedCapabilities ?? {});
    this.db.transaction(() => {
      this.db.run("INSERT INTO worker_executions(id,task_id,objective,status,harness,workspace_id,workspace_access,updated_at) VALUES (?,?,?,?,?,?,?,?)", workerId, input.taskId, input.objective, status, "pi", input.workspaceId ?? null, input.workspaceAccess ?? null, timestamp);
      this.event(input.taskId, "WORKER_CREATED", workerId, { status });
      this.db.run("UPDATE tasks SET status=?,updated_at=? WHERE id=? AND status IN ('CREATED','QUEUED')", status === "PENDING" ? "QUEUED" : "RUNNING", timestamp, input.taskId);
    });
    if (status === "STARTING") void this.startWorker(workerId);
    return worker;
  }

  async startWorker(workerId: string): Promise<void> {
    const worker = this.getWorker(workerId);
    if (worker.status !== "STARTING" && worker.status !== "PENDING") return;
    if (worker.workspaceAccess === "WRITE" && worker.workspaceId && !this.hasLock(worker.workspaceId, worker.id) && !this.tryAcquireLock(worker.workspaceId, worker.id)) return;
    const sessionPath = join(this.options.workerRoot, "sessions", `${worker.id}.jsonl`);
    await mkdir(join(this.options.workerRoot, "sessions"), { recursive: true });
    const session = await this.pi.createSession(sessionPath);
    this.activeSessions.set(worker.id, session);
    const startedAt = nowIso();
    this.db.transaction(() => {
      this.db.run("UPDATE worker_executions SET status='RUNNING',harness_session_id=?,started_at=?,updated_at=? WHERE id=?", session.sessionId, startedAt, startedAt, worker.id);
      this.db.run("UPDATE tasks SET status='RUNNING',updated_at=? WHERE id=?", startedAt, worker.taskId);
      this.event(worker.taskId, "WORKER_STARTED", worker.id, { sessionId: session.sessionId });
    });
    const task = this.getTask(worker.taskId);
    const projectPath = worker.workspaceId ? join(this.options.workerRoot, "projects", worker.workspaceId) : join(this.options.workerRoot, "scratch", worker.id);
    await mkdir(projectPath, { recursive: true });
    const prompt = [
      "You are an Agent Home Worker. Execute the assigned objective in the authorized workspace.",
      `Task ID: ${task.id}`,
      `Worker ID: ${worker.id}`,
      `Objective: ${worker.objective}`,
      `Workspace: ${projectPath}`,
      "Do not send chat messages or access credentials. Return a concise verified result.",
      "If blocked by missing user information, return JSON exactly: {\"type\":\"question\",\"question\":\"...\"}.",
    ].join("\n");
    try {
      const output = await this.pi.send(session, prompt, { cwd: projectPath, timeoutMs: this.config.runtime.piTimeoutMs, taskId: task.id, workerId: worker.id });
      const question = this.parseQuestion(output);
      if (question) await this.askParent(worker.id, question);
      else await this.finishWorker(worker.id, { outcome: "COMPLETED", summary: output || "Worker completed without a textual summary." });
    } catch (error) {
      if (this.getWorker(worker.id).status === "CANCELLED") return;
      await this.failWorker(worker.id, String(error));
    }
  }

  async reportProgress(workerId: string, summary: string, phase?: string): Promise<void> {
    const worker = this.getWorker(workerId);
    this.db.transaction(() => this.event(worker.taskId, "WORKER_PROGRESS", workerId, { summary, ...(phase ? { phase } : {}) }));
    await this.emit({ type: "TASK_PROGRESS", taskId: worker.taskId, workerId, payload: { summary, ...(phase ? { phase } : {}) } });
  }

  async askParent(workerId: string, question: string): Promise<string> {
    const worker = this.getWorker(workerId);
    const existing = this.db.get("SELECT id FROM pending_questions WHERE worker_id=? AND status='OPEN'", workerId);
    if (existing) throw new Error("ONE_OPEN_QUESTION_PER_WORKER");
    const questionId = newId("question");
    const createdAt = nowIso();
    this.db.transaction(() => {
      this.db.run("INSERT INTO pending_questions(id,task_id,worker_id,question,status,created_at) VALUES (?,?,?,?,?,?)", questionId, worker.taskId, workerId, question, "OPEN", createdAt);
      this.db.run("UPDATE worker_executions SET status='WAITING_USER',updated_at=? WHERE id=?", createdAt, workerId);
      this.db.run("UPDATE tasks SET status='WAITING_USER',updated_at=? WHERE id=?", createdAt, worker.taskId);
      this.event(worker.taskId, "QUESTION_CREATED", workerId, { questionId, question });
    });
    await this.emit({ type: "TASK_QUESTION", taskId: worker.taskId, workerId, questionId, payload: { question } });
    return questionId;
  }

  async answerQuestion(questionId: string, answer: string, source: { message: PlatformMessageRef; conversationId: string }): Promise<void> {
    const question = this.db.get<{ id: string; task_id: string; worker_id: string; status: string }>("SELECT id,task_id,worker_id,status FROM pending_questions WHERE id=?", questionId);
    if (!question || question.status !== "OPEN") throw new Error("QUESTION_NOT_OPEN");
    const timestamp = nowIso();
    const mailboxId = newId("mail");
    this.db.transaction(() => {
      this.db.run("UPDATE pending_questions SET status='ANSWERED',answer=?,answered_at=? WHERE id=? AND status='OPEN'", answer, timestamp, questionId);
      this.db.run("INSERT INTO task_mailbox(id,task_id,type,source_conversation_id,source_message_key,content,status,created_at) VALUES (?,?,?,?,?,?,?,?)", mailboxId, question.task_id, "FOLLOW_UP", source.conversationId, messageKey(source.message), answer, "PENDING", timestamp);
      this.event(question.task_id, "QUESTION_ANSWERED", question.worker_id, { questionId, mailboxId });
    });
    const session = this.activeSessions.get(question.worker_id);
    try {
      if (!session) throw new Error("WORKER_SESSION_UNAVAILABLE");
      await this.pi.steer(session, `User answer to your blocking question: ${answer}`, { timeoutMs: this.config.runtime.piTimeoutMs });
      this.db.transaction(() => {
        this.db.run("UPDATE task_mailbox SET status='DELIVERED',delivered_at=? WHERE id=?", nowIso(), mailboxId);
        this.db.run("UPDATE pending_questions SET status='CLOSED',closed_at=? WHERE id=?", nowIso(), questionId);
        this.db.run("UPDATE worker_executions SET status='RUNNING',updated_at=? WHERE id=?", nowIso(), question.worker_id);
        this.db.run("UPDATE tasks SET status='RUNNING',updated_at=? WHERE id=?", nowIso(), question.task_id);
      });
    } catch (error) {
      this.recordException(question.task_id, question.worker_id, "answerQuestion", "WORKER_DELIVERY", String(error));
    }
  }

  async addFollowUp(taskId: string, content: string, source: { conversationId: string; message: PlatformMessageRef }): Promise<void> {
    const task = this.getTask(taskId);
    if (!task.capabilities.tasks.canFollowUp) throw new Error("TASK_FOLLOW_UP_DENIED");
    const id = newId("mail");
    this.db.transaction(() => {
      this.db.run("INSERT INTO task_mailbox(id,task_id,type,source_conversation_id,source_message_key,content,status,created_at) VALUES (?,?,?,?,?,?,?,?)", id, taskId, "FOLLOW_UP", source.conversationId, messageKey(source.message), content, "PENDING", nowIso());
      this.event(taskId, "FOLLOW_UP_ADDED", undefined, { mailboxId: id });
    });
    const worker = this.db.get<{ id: string }>("SELECT id FROM worker_executions WHERE task_id=? AND status='RUNNING' ORDER BY updated_at DESC LIMIT 1", taskId);
    if (worker) {
      const session = this.activeSessions.get(worker.id);
      try {
        if (!session) throw new Error("WORKER_SESSION_UNAVAILABLE");
        await this.pi.steer(session, `Additional user instruction: ${content}`, { timeoutMs: this.config.runtime.piTimeoutMs });
        this.db.run("UPDATE task_mailbox SET status='DELIVERED',delivered_at=? WHERE id=?", nowIso(), id);
      } catch (error) { this.recordException(taskId, worker.id, "addFollowUp", "WORKER_DELIVERY", String(error)); }
    }
  }

  async requestCancel(taskId: string): Promise<void> {
    const task = this.getTask(taskId);
    if (!task.capabilities.tasks.canCancel) throw new Error("TASK_CANCEL_DENIED");
    this.db.transaction(() => this.event(taskId, "CANCEL_REQUESTED"));
    const workers = this.db.all<{ id: string; status: WorkerStatus; workspace_id: string | null }>("SELECT id,status,workspace_id FROM worker_executions WHERE task_id=? AND status IN ('PENDING','STARTING','RUNNING','WAITING_USER','STOPPING')", taskId);
    let confirmed = true;
    for (const worker of workers) {
      const session = this.activeSessions.get(worker.id);
      if (session && !(await this.pi.abort(session))) confirmed = false;
    }
    if (!confirmed) { this.recordException(taskId, undefined, "cancel", "PROCESS_STATE_UNKNOWN", "Worker termination could not be confirmed"); return; }
    const timestamp = nowIso();
    this.db.transaction(() => {
      for (const worker of workers) {
        this.db.run("UPDATE worker_executions SET status='CANCELLED',finished_at=?,updated_at=? WHERE id=?", timestamp, timestamp, worker.id);
        if (worker.workspace_id) this.db.run("DELETE FROM project_locks WHERE project_id=? AND owner_worker_id=?", worker.workspace_id, worker.id);
        this.db.run("UPDATE pending_questions SET status='CLOSED',closed_at=? WHERE worker_id=? AND status='OPEN'", timestamp, worker.id);
        this.event(taskId, "WORKER_CANCELLED", worker.id);
      }
      this.db.run("UPDATE tasks SET status='CANCELLED',completed_at=?,updated_at=? WHERE id=?", timestamp, timestamp, taskId);
      this.event(taskId, "TASK_CANCELLED");
    });
  }

  async finishWorker(workerId: string, result: { outcome: "COMPLETED" | "PARTIAL" | "FAILED"; summary: string; artifacts?: string[] }): Promise<void> {
    const worker = this.getWorker(workerId);
    const status: WorkerStatus = result.outcome === "COMPLETED" ? "COMPLETED" : result.outcome === "PARTIAL" ? "COMPLETED" : "FAILED";
    const timestamp = nowIso();
    this.db.transaction(() => {
      this.db.run("UPDATE worker_executions SET status=?,finished_at=?,updated_at=? WHERE id=?", status, timestamp, timestamp, workerId);
      if (worker.workspaceId) this.db.run("DELETE FROM project_locks WHERE project_id=? AND owner_worker_id=?", worker.workspaceId, workerId);
      this.event(worker.taskId, "WORKER_COMPLETED", workerId, { outcome: result.outcome, summary: result.summary, artifacts: result.artifacts ?? [] });
      const remaining = Number(this.db.get<{ count: number }>("SELECT count(*) AS count FROM worker_executions WHERE task_id=? AND status IN ('PENDING','STARTING','RUNNING','WAITING_USER','STOPPING')", worker.taskId)?.count ?? 0);
      if (remaining === 0) {
        this.db.run("UPDATE tasks SET status=?,updated_at=? WHERE id=?", result.outcome === "FAILED" ? "FAILED" : result.outcome === "PARTIAL" ? "PARTIAL" : "COMPLETED", timestamp, worker.taskId);
        if (result.outcome !== "PARTIAL") this.db.run("UPDATE tasks SET completed_at=? WHERE id=?", timestamp, worker.taskId);
      } else {
        this.db.run("UPDATE tasks SET status='RUNNING',updated_at=? WHERE id=?", timestamp, worker.taskId);
      }
    });
    this.activeSessions.delete(workerId);
    const task = this.getTask(worker.taskId);
    await this.emit({ type: "TASK_RESULT", taskId: task.id, workerId, payload: { ...result } });
  }

  async failWorker(workerId: string, error: string): Promise<void> {
    const worker = this.getWorker(workerId);
    const timestamp = nowIso();
    this.db.transaction(() => {
      this.db.run("UPDATE worker_executions SET status='FAILED',finished_at=?,updated_at=? WHERE id=?", timestamp, timestamp, workerId);
      if (worker.workspaceId) this.db.run("DELETE FROM project_locks WHERE project_id=? AND owner_worker_id=?", worker.workspaceId, workerId);
      this.event(worker.taskId, "WORKER_FAILED", workerId, { error: error.slice(0, 1000) });
      this.db.run("UPDATE tasks SET status='FAILED',completed_at=?,updated_at=? WHERE id=?", timestamp, timestamp, worker.taskId);
    });
    this.activeSessions.delete(workerId);
    this.recordException(worker.taskId, workerId, "worker", "PI_FAILURE", error);
    await this.emit({ type: "TASK_RESULT", taskId: worker.taskId, workerId, payload: { outcome: "FAILED", summary: "Worker failed." } });
  }

  recover(): void {
    const active = this.db.all<{ id: string; task_id: string; workspace_id: string | null; harness_session_id: string | null; status: WorkerStatus }>("SELECT id,task_id,workspace_id,harness_session_id,status FROM worker_executions WHERE status IN ('STARTING','RUNNING','WAITING_USER','STOPPING')");
    for (const worker of active) {
      if (worker.status === "WAITING_USER") {
        if (worker.harness_session_id) this.activeSessions.set(worker.id, { sessionId: worker.harness_session_id, sessionPath: join(this.options.workerRoot, "sessions", `${worker.id}.jsonl`) });
        this.db.run("UPDATE tasks SET status='WAITING_USER',updated_at=? WHERE id=?", nowIso(), worker.task_id);
        continue;
      }
      this.db.transaction(() => {
        this.db.run("UPDATE worker_executions SET status='INTERRUPTED',updated_at=? WHERE id=?", nowIso(), worker.id);
        if (worker.workspace_id) this.db.run("DELETE FROM project_locks WHERE project_id=? AND owner_worker_id=?", worker.workspace_id, worker.id);
        this.event(worker.task_id, "WORKER_INTERRUPTED", worker.id, { reason: "runtime_restart" });
        this.db.run("UPDATE tasks SET status='INTERRUPTED',updated_at=? WHERE id=? AND status NOT IN ('COMPLETED','PARTIAL','FAILED','CANCELLED')", nowIso(), worker.task_id);
      });
    }
  }

  getTask(taskId: string): TaskRecord {
    const row = this.db.get<Record<string, unknown>>("SELECT * FROM tasks WHERE id=?", taskId);
    if (!row) throw new Error("TASK_NOT_FOUND");
    return { id: row.id as string, title: row.title as string, goal: row.goal as string, status: row.status as TaskStatus, requester: JSON.parse(row.requester_json as string) as TaskRequester, trust: row.trust as TaskRecord["trust"], originConversationId: row.origin_conversation_id as string, notificationConversationId: row.notification_conversation_id as string, ...(row.parent_task_id ? { parentTaskId: row.parent_task_id as string } : {}), capabilities: JSON.parse(row.capabilities_json as string) as CapabilitySet, createdAt: row.created_at as string, updatedAt: row.updated_at as string, ...(row.completed_at ? { completedAt: row.completed_at as string } : {}) };
  }

  getWorker(workerId: string): WorkerExecutionRecord {
    const row = this.db.get<Record<string, unknown>>("SELECT * FROM worker_executions WHERE id=?", workerId);
    if (!row) throw new Error("WORKER_NOT_FOUND");
    return { id: row.id as string, taskId: row.task_id as string, objective: row.objective as string, status: row.status as WorkerStatus, harness: "pi", ...(row.harness_session_id ? { harnessSessionId: row.harness_session_id as string } : {}), ...(row.workspace_id ? { workspaceId: row.workspace_id as string } : {}), ...(row.workspace_access ? { workspaceAccess: row.workspace_access as "READ" | "WRITE" } : {}), ...(row.process_id ? { processId: row.process_id as number } : {}), ...(row.started_at ? { startedAt: row.started_at as string } : {}), updatedAt: row.updated_at as string, ...(row.finished_at ? { finishedAt: row.finished_at as string } : {}) };
  }

  listTasks(conversationId?: string): TaskRecord[] {
    const rows = conversationId ? this.db.all<{ id: string }>("SELECT id FROM tasks WHERE origin_conversation_id=? OR notification_conversation_id=? ORDER BY updated_at DESC", conversationId, conversationId) : this.db.all<{ id: string }>("SELECT id FROM tasks ORDER BY updated_at DESC");
    return rows.map((row) => this.getTask(row.id));
  }

  getProgress(taskId: string): string[] {
    return this.db.all<{ payload_json: string }>("SELECT payload_json FROM task_events WHERE task_id=? AND type='WORKER_PROGRESS' ORDER BY created_at DESC LIMIT 10", taskId).map((row) => (JSON.parse(row.payload_json) as { summary?: string }).summary ?? "");
  }

  private async emit(event: RuntimeEvent): Promise<void> {
    const task = event.taskId ? this.getTask(event.taskId) : undefined;
    if (task) await this.options.onEvent?.(event, task);
  }

  private event(taskId: string, type: string, workerId?: string, payload: Record<string, unknown> = {}): void { this.db.run("INSERT INTO task_events(id,task_id,worker_id,type,payload_json,created_at) VALUES (?,?,?,?,?,?)", newId("taskevt"), taskId, workerId ?? null, type, JSON.stringify(payload), nowIso()); }

  private recordException(taskId: string, workerId: string | undefined, operation: string, category: string, summary: string): void { this.db.run("INSERT INTO runtime_exceptions(id,task_id,worker_id,operation,category,summary,created_at) VALUES (?,?,?,?,?,?,?)", newId("exception"), taskId, workerId ?? null, operation, category, summary.slice(0, 2000), nowIso()); }

  private tryAcquireLock(projectId: string, workerId: string): boolean {
    try { this.db.run("INSERT INTO project_locks(project_id,mode,owner_worker_id,acquired_at) VALUES (?,?,?,?)", projectId, "WRITE", workerId, nowIso()); return true; } catch { return false; }
  }

  private hasLock(projectId: string, workerId: string): boolean { return Boolean(this.db.get("SELECT 1 AS found FROM project_locks WHERE project_id=? AND owner_worker_id=?", projectId, workerId)); }

  private parseQuestion(output: string): string | null {
    try { const value = JSON.parse(output) as { type?: string; question?: string }; return value.type === "question" && value.question ? value.question : null; } catch { return null; }
  }
}
