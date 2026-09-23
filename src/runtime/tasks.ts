import { access, mkdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, join, relative, resolve } from "node:path";
import type { AppConfig } from "../config.js";
import type { SqliteStore } from "../db.js";
import { attenuateTask, attenuateWorker, capabilityWithin, deriveCapabilities, validateCapabilitySet, type AuthorizationDecision, authorizeSend } from "../auth.js";
import { newId, nowIso, messageKey } from "../shared/ids.js";
import type { ArtifactRef, CapabilitySet, PlatformMessageRef, TaskRecord, TaskRequester, TaskStatus, WorkerExecutionRecord, WorkerStatus } from "../shared/types.js";
import type { ArtifactService } from "./artifacts.js";
import type { PiHarness, PiProcessIdentity, PiSandbox, PiSession } from "./pi.js";
import type { GatewayMcpClient } from "./mcp.js";
import type { Logger } from "../shared/logger.js";

export type RuntimeEvent = { type: string; taskId?: string; workerId?: string; questionId?: string; payload?: Record<string, unknown> };

export const WORKER_CONTROL_PREFIX = "AGENT_HOME_CONTROL ";
const MAIN_EVENT_TYPES = new Set(["TASK_QUESTION", "TASK_RESULT", "TASK_PROGRESS", "TASK_EXCEPTION", "TASK_INTERRUPTED"]);

export type ProgressInput = { summary: string; currentAction?: string; completedSteps?: string[] };
export type WorkerQuestion = { question: string };
export type ArtifactProposal = { path: string; mime?: string };
export type WorkerResult = { outcome: "COMPLETED" | "PARTIAL" | "FAILED"; summary: string; details?: string; artifacts?: string[] };
export type WorkerControlFrame =
  | ({ type: "progress" } & ProgressInput)
  | ({ type: "question" } & WorkerQuestion)
  | ({ type: "artifact" } & ArtifactProposal)
  | ({ type: "finish" } & WorkerResult);

export interface WorkerControl {
  reportProgress(input: ProgressInput): Promise<void>;
  askParent(input: WorkerQuestion): Promise<{ questionId: string }>;
  publishArtifact(input: ArtifactProposal): Promise<{ artifactId: string; filename: string; size: number }>;
  finishTask(input: WorkerResult): Promise<void>;
}

export interface TaskServiceOptions {
  onEvent?: (event: RuntimeEvent, task: TaskRecord) => Promise<void>;
  workerRoot: string;
  mcpControl?: GatewayMcpClient;
  mcpEndpoint?: string;
  workerToolExtensionPath?: string;
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
    const parentCapabilities = validateCapabilitySet(input.parentCapabilities);
    if (!parentCapabilities.tasks.canCreate) { this.audit("task.create", "DENY", "TASK_CREATE_DENIED", input.originConversationId, input.requester.userId); throw new Error("TASK_CREATE_DENIED"); }
    if (!this.conversationAllowed(parentCapabilities.qq.sendConversations, input.notificationConversationId)) { this.audit("task.create", "DENY", "TASK_NOTIFICATION_DENIED", input.notificationConversationId, input.requester.userId); throw new Error("TASK_NOTIFICATION_DENIED"); }
    if (this.activeTaskCount() >= this.limit("maxTasks")) throw new Error("TASK_QUOTA_EXCEEDED");
    if (input.parentTaskId) {
      const parentTask = this.getTask(input.parentTaskId);
      if (!this.taskVisibleToActor(parentTask, parentCapabilities)) { this.audit("task.create", "DENY", "TASK_PARENT_DENIED", input.parentTaskId, input.requester.userId); throw new Error("TASK_PARENT_DENIED"); }
    }
    const canonical = this.canonicalCapabilities(input);
    if (canonical && !capabilityWithin(parentCapabilities, canonical)) throw new Error("CAPABILITY_CONTEXT_INVALID");
    const id = newId("task");
    let capabilities: CapabilitySet;
    try { capabilities = attenuateTask(parentCapabilities, input.requestedCapabilities ?? {}, id); }
    catch (error) { this.audit("task.create", "DENY", error instanceof Error ? error.message : String(error), id, input.requester.userId); throw error; }
    const timestamp = nowIso();
    const task: TaskRecord = { id, title: input.title, goal: input.goal, status: "CREATED", requester: input.requester, trust: input.trust, originConversationId: input.originConversationId, notificationConversationId: input.notificationConversationId, ...(input.parentTaskId ? { parentTaskId: input.parentTaskId } : {}), capabilities, createdAt: timestamp, updatedAt: timestamp };
    this.db.transaction(() => {
      this.db.run("INSERT INTO tasks(id,title,goal,status,requester_json,trust,origin_conversation_id,notification_conversation_id,parent_task_id,capabilities_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", id, task.title, task.goal, task.status, JSON.stringify(task.requester), task.trust, task.originConversationId, task.notificationConversationId, task.parentTaskId ?? null, JSON.stringify(task.capabilities), timestamp, timestamp);
      this.event(id, "TASK_CREATED", undefined, { title: task.title });
    });
    this.audit("task.create", "ALLOW", undefined, id, input.requester.userId, id);
    return task;
  }

  async createWorker(input: { taskId: string; objective: string; workspaceId?: string; workspaceAccess?: "READ" | "WRITE"; requestedCapabilities?: Partial<CapabilitySet>; artifactRefs?: ArtifactRef[]; actor: CapabilitySet }): Promise<WorkerExecutionRecord> {
    const task = this.getTask(input.taskId);
    if (this.isTerminalTask(task.status) || this.cancellationRequested(task.id)) throw new Error("TASK_CREATE_WORKER_DENIED");
    const workspaceId = input.workspaceId ? this.canonicalWorkspaceId(input.workspaceId) : undefined;
    const actor = validateCapabilitySet(input.actor);
    if (!actor.tasks.canCreate || (!actor.tasks.visibleTaskIds.includes(task.id) && !actor.qq.sendConversations.includes(task.originConversationId) && !actor.qq.sendConversations.includes(task.notificationConversationId))) throw new Error("TASK_CREATE_WORKER_DENIED");
    if (workspaceId && input.workspaceAccess && !task.capabilities.projects.some((project) => (project.projectId === "*" || project.projectId === workspaceId) && (project.access === "WRITE" || project.access === input.workspaceAccess))) throw new Error("PROJECT_ACCESS_DENIED");
    const workerCount = Number(this.db.get<{ count: number }>("SELECT count(*) AS count FROM worker_executions WHERE task_id=? AND status IN ('PENDING','STARTING','RUNNING','WAITING_USER','STOPPING')", input.taskId)?.count ?? 0);
    if (workerCount >= this.config.runtime.maxWorkers) throw new Error("WORKER_QUOTA_EXCEEDED");
    if (this.activeWorkerCount() >= this.limit("maxWorkersTotal")) throw new Error("WORKER_TOTAL_QUOTA_EXCEEDED");
    if (workspaceId && this.activeProjectWorkerCount(workspaceId) >= this.limit("maxWorkersPerProject")) throw new Error("WORKER_PROJECT_QUOTA_EXCEEDED");
    if (this.activeRequesterWorkerCount(task.requester) >= this.limit("maxWorkersPerRequester")) throw new Error("WORKER_REQUESTER_QUOTA_EXCEEDED");
    const workerId = newId("worker");
    const requestedCapabilities = input.requestedCapabilities ?? {
      memory: { allowedScopes: task.capabilities.memory.allowedScopes },
      projects: workspaceId && input.workspaceAccess ? [{ projectId: workspaceId, access: input.workspaceAccess }] : [],
      qq: { readConversations: [], sendConversations: [] },
      plugins: { allowedActions: task.capabilities.plugins.allowedActions },
      artifacts: { readableArtifactAuthorities: task.capabilities.artifacts.readableArtifactAuthorities, publishTaskIds: [input.taskId], allowedDestinations: [] },
      tasks: { canCreate: false, visibleTaskIds: [], canCancel: false, canFollowUp: false },
    };
    let capabilities: CapabilitySet;
    try { capabilities = attenuateWorker(task.capabilities, requestedCapabilities); }
    catch (error) { this.audit("worker.create", "DENY", error instanceof Error ? error.message : String(error), task.id, task.requester.userId, task.id); throw error; }
    const lockRequired = input.workspaceAccess === "WRITE" && Boolean(workspaceId);
    const lockAcquired = lockRequired && this.tryAcquireLock(workspaceId as string, workerId);
    const status: WorkerStatus = lockRequired && !lockAcquired ? "PENDING" : "STARTING";
    const timestamp = nowIso();
    const worker: WorkerExecutionRecord = { id: workerId, taskId: input.taskId, objective: input.objective, status, harness: "pi", ...(workspaceId ? { workspaceId } : {}), ...(input.workspaceAccess ? { workspaceAccess: input.workspaceAccess } : {}), ...(input.artifactRefs?.length ? { artifactRefs: input.artifactRefs } : {}), updatedAt: timestamp };
    worker.capabilities = capabilities;
    try {
      this.db.transaction(() => {
        this.db.run("INSERT INTO worker_executions(id,task_id,objective,status,harness,workspace_id,workspace_access,capabilities_json,artifact_refs_json,mcp_binding_token,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)", workerId, input.taskId, input.objective, status, "pi", workspaceId ?? null, input.workspaceAccess ?? null, JSON.stringify(capabilities), input.artifactRefs?.length ? JSON.stringify(input.artifactRefs) : null, null, timestamp);
        this.event(input.taskId, "WORKER_CREATED", workerId, { status });
        this.db.run("UPDATE tasks SET status=?,updated_at=? WHERE id=? AND status IN ('CREATED','QUEUED')", status === "PENDING" ? "QUEUED" : "RUNNING", timestamp, input.taskId);
      });
    } catch (error) {
      if (lockAcquired && workspaceId) this.db.run("DELETE FROM project_locks WHERE project_id=? AND owner_worker_id=?", workspaceId, workerId);
      throw error;
    }
    this.audit("worker.create", "ALLOW", undefined, workerId, task.requester.userId, task.id);
    try { await this.ensureWorkerBinding(workerId); }
    catch (error) { await this.failWorker(workerId, String(error)); throw error; }
    if (status === "STARTING") void this.startWorker(workerId).catch((error) => this.log.error("Worker startup failed", { workerId, error: String(error) }));
    return worker;
  }

  async startWorker(workerId: string): Promise<void> {
    let worker = this.getWorker(workerId);
    if (worker.status !== "STARTING" && worker.status !== "PENDING") return;
    if (worker.status === "PENDING" && worker.workspaceAccess === "WRITE" && worker.workspaceId && !this.hasLock(worker.workspaceId, worker.id) && !this.tryAcquireLock(worker.workspaceId, worker.id)) return;
    if (worker.status === "PENDING") {
      const claimed = this.db.run("UPDATE worker_executions SET status='STARTING',updated_at=? WHERE id=? AND status='PENDING'", nowIso(), worker.id).changes > 0;
      if (!claimed) return;
      worker = this.getWorker(workerId);
    }
    if (!this.workerCanStart(worker.id)) return;
    const sessionPath = this.workerSessionPath(worker.id);
    let projectPath: string;
    try {
      projectPath = this.workerWorkspace(worker);
      await mkdir(dirname(sessionPath), { recursive: true });
      await mkdir(projectPath, { recursive: true });
    } catch (error) {
      await this.failWorker(worker.id, String(error));
      throw error;
    }
    let mcpToken: string | undefined;
    try { mcpToken = await this.ensureWorkerBinding(worker.id); }
    catch (error) { await this.failWorker(worker.id, String(error)); return; }
    if (!this.workerCanStart(worker.id)) return;
    const sandbox: PiSandbox = { workspaceRoot: projectPath, sessionRoot: dirname(sessionPath), writeAccess: worker.workspaceAccess === "WRITE", ...(mcpToken && this.options.mcpEndpoint ? { mcpEndpoint: this.options.mcpEndpoint, mcpToken } : {}) };
    const task = this.getTask(worker.taskId);
    const inboundFiles: string[] = [];
    let session: PiSession;
    try {
      for (const ref of worker.artifactRefs ?? []) {
        const materialized = await this.artifacts.materializeForRead(ref, { conversationId: task.originConversationId, requesterId: task.requester.userId, taskId: task.id, readCapability: worker.capabilities?.artifacts ?? { readableArtifactAuthorities: [] } }, projectPath);
        inboundFiles.push(`${materialized.metadata.filename} (${materialized.metadata.mime ?? "application/octet-stream"}, ${materialized.metadata.size} bytes), available at sandbox-relative path ${relative(projectPath, materialized.path)}`);
      }
      session = await this.pi.createSession(sessionPath, { cwd: projectPath, sandbox, ...(this.options.workerToolExtensionPath && mcpToken ? { extensionPath: this.options.workerToolExtensionPath } : {}) });
      if (!this.workerCanStart(worker.id)) { await this.pi.abort(session); return; }
      this.activeSessions.set(worker.id, session);
      const processIdentity = await this.pi.processInfo?.(session);
      const processId = processIdentity?.pid ?? this.pi.processId?.(session);
      const startedAt = nowIso();
      const started = this.db.transaction(() => {
        const update = this.db.run("UPDATE worker_executions SET status='RUNNING',harness_session_id=?,harness_session_path=?,process_id=?,started_at=?,updated_at=? WHERE id=? AND status='STARTING'", session.sessionId, session.sessionPath, processId ?? null, startedAt, startedAt, worker.id);
        if (update.changes === 0) return false;
        this.db.run("DELETE FROM owned_processes WHERE worker_id=?", worker.id);
        if (processId) this.db.run("INSERT INTO owned_processes(id,task_id,worker_id,pid,process_group_id,command_summary,started_at,pid_start_time) VALUES (?,?,?,?,?,?,?,?)", `process-${worker.id}`, task.id, worker.id, processId, processIdentity?.processGroupId ?? processId, "pi --mode rpc --session", startedAt, processIdentity?.startTime ?? null);
        this.db.run("UPDATE tasks SET status='RUNNING',updated_at=? WHERE id=? AND status IN ('CREATED','QUEUED','RUNNING','WAITING_USER')", startedAt, worker.taskId);
        this.event(worker.taskId, "WORKER_STARTED", worker.id, { sessionId: session.sessionId });
        return true;
      });
      if (!started) { this.activeSessions.delete(worker.id); await this.pi.abort(session); return; }
    }
    catch (error) { await this.failWorker(worker.id, String(error)); return; }
    const prompt = [
      "You are an Agent Home Worker. Execute the assigned objective in the authorized workspace.",
      `Task ID: ${task.id}`,
      `Worker ID: ${worker.id}`,
      `Objective: ${worker.objective}`,
      `Workspace: ${projectPath}`,
      inboundFiles.length ? `Authorized inbound files (materialized in the workspace):\n${inboundFiles.join("\n")}` : "No inbound files were supplied.",
      "Do not send chat messages or access credentials. Return a concise verified result.",
      `Runtime control frames must be separate lines prefixed with ${WORKER_CONTROL_PREFIX.trimEnd()} and contain JSON. Supported types are progress, question, artifact, and finish.`,
      `Use ${WORKER_CONTROL_PREFIX}{"type":"progress","summary":"..."} for meaningful progress; use question with a question field; use artifact with a workspace-relative path; use finish with outcome COMPLETED, PARTIAL, or FAILED and a summary.`,
      "Plain text is only a result summary. It never grants authorization or changes Runtime state.",
    ].join("\n");
    try {
      const outputPromise = this.pi.send(session, prompt, { cwd: projectPath, sandbox, timeoutMs: this.config.runtime.piTimeoutMs, taskId: task.id, workerId: worker.id, ...(this.options.workerToolExtensionPath && mcpToken ? { extensionPath: this.options.workerToolExtensionPath } : {}) });
      const output = await outputPromise;
      await this.handleWorkerOutput(worker.id, output);
      const afterOutput = this.getWorker(worker.id).status;
      if (afterOutput === "RUNNING" || afterOutput === "WAITING_USER") await this.replayPendingMailbox(worker.id, session);
    } catch (error) {
      if (["STOPPING", "CANCELLED", "COMPLETED", "FAILED"].includes(this.getWorker(worker.id).status)) return;
      await this.failWorker(worker.id, String(error));
    }
  }

  async reportProgress(workerId: string, summary: string, phase?: string): Promise<void> {
    const worker = this.getWorker(workerId);
    if (!["STARTING", "RUNNING", "WAITING_USER"].includes(worker.status) || this.cancellationRequested(worker.taskId)) return;
    this.db.transaction(() => {
      const payload = { summary, ...(phase ? { phase } : {}) };
      this.event(worker.taskId, "WORKER_PROGRESS", workerId, payload);
      this.event(worker.taskId, "TASK_PROGRESS", workerId, payload);
    });
    await this.emit({ type: "TASK_PROGRESS", taskId: worker.taskId, workerId, payload: { summary, ...(phase ? { phase } : {}) } });
  }

  async askParent(workerId: string, question: string): Promise<string> {
    const worker = this.getWorker(workerId);
    if (worker.status !== "RUNNING" || this.cancellationRequested(worker.taskId)) throw new Error("WORKER_QUESTION_DENIED");
    const existing = this.db.get("SELECT id FROM pending_questions WHERE worker_id=? AND status='OPEN'", workerId);
    if (existing) throw new Error("ONE_OPEN_QUESTION_PER_WORKER");
    const questionId = newId("question");
    const createdAt = nowIso();
    this.db.transaction(() => {
      this.db.run("INSERT INTO pending_questions(id,task_id,worker_id,question,status,created_at) VALUES (?,?,?,?,?,?)", questionId, worker.taskId, workerId, question, "OPEN", createdAt);
      this.db.run("UPDATE worker_executions SET status='WAITING_USER',updated_at=? WHERE id=?", createdAt, workerId);
      this.db.run("UPDATE tasks SET status='WAITING_USER',updated_at=? WHERE id=?", createdAt, worker.taskId);
      this.event(worker.taskId, "QUESTION_CREATED", workerId, { questionId, question });
      this.event(worker.taskId, "TASK_QUESTION", workerId, { questionId, question });
    });
    await this.emit({ type: "TASK_QUESTION", taskId: worker.taskId, workerId, questionId, payload: { question } });
    return questionId;
  }

  async answerQuestion(questionId: string, answer: string, source: { message: PlatformMessageRef; conversationId: string; capabilities?: CapabilitySet }): Promise<void> {
    const question = this.db.get<{ id: string; task_id: string; worker_id: string; status: string }>("SELECT id,task_id,worker_id,status FROM pending_questions WHERE id=?", questionId);
    if (!question || question.status !== "OPEN") throw new Error("QUESTION_NOT_OPEN");
    const task = this.getTask(question.task_id);
    if (this.getWorker(question.worker_id).status !== "WAITING_USER") throw new Error("QUESTION_NOT_OPEN");
    if (this.isTerminalTask(task.status) || this.cancellationRequested(task.id)) throw new Error("QUESTION_NOT_OPEN");
    if (source.capabilities) {
      const actor = validateCapabilitySet(source.capabilities);
      if (!actor.tasks.canFollowUp || !actor.qq.sendConversations.includes(source.conversationId)) throw new Error("QUESTION_ANSWER_DENIED");
    }
    const timestamp = nowIso();
    const mailboxId = newId("mail");
    const answered = this.db.transaction(() => {
      const update = this.db.run("UPDATE pending_questions SET status='ANSWERED',answer=?,answered_at=? WHERE id=? AND status='OPEN'", answer, timestamp, questionId);
      if (update.changes === 0) return false;
      this.db.run("INSERT INTO task_mailbox(id,task_id,type,source_conversation_id,source_message_key,content,status,created_at,worker_id,question_id) VALUES (?,?,?,?,?,?,?,?,?,?)", mailboxId, question.task_id, "FOLLOW_UP", source.conversationId, messageKey(source.message), answer, "PENDING", timestamp, question.worker_id, questionId);
      this.event(question.task_id, "QUESTION_ANSWERED", question.worker_id, { questionId, mailboxId });
      return true;
    });
    if (!answered) throw new Error("QUESTION_NOT_OPEN");
    const session = this.activeSessions.get(question.worker_id);
    try {
      if (!session) throw new Error("WORKER_SESSION_UNAVAILABLE");
      if (this.cancellationRequested(question.task_id) || this.getWorker(question.worker_id).status === "STOPPING") throw new Error("WORKER_SESSION_UNAVAILABLE");
      const output = await this.pi.steer(session, `User answer to your blocking question: ${answer}`, { timeoutMs: this.config.runtime.piTimeoutMs });
      this.db.transaction(() => {
        this.db.run("UPDATE task_mailbox SET status='DELIVERED',delivered_at=? WHERE id=? AND status IN ('PENDING','DELIVERED')", nowIso(), mailboxId);
        this.db.run("UPDATE pending_questions SET status='CLOSED',closed_at=? WHERE id=? AND status='ANSWERED'", nowIso(), questionId);
        this.db.run("UPDATE worker_executions SET status='RUNNING',updated_at=? WHERE id=? AND status='WAITING_USER'", nowIso(), question.worker_id);
        this.db.run("UPDATE tasks SET status='RUNNING',updated_at=? WHERE id=? AND status='WAITING_USER'", nowIso(), question.task_id);
      });
      await this.handleWorkerOutput(question.worker_id, output);
      this.markMailboxConsumed(mailboxId);
    } catch (error) {
      this.recordException(question.task_id, question.worker_id, "answerQuestion", "WORKER_DELIVERY", String(error));
    }
  }

  async addFollowUp(taskId: string, content: string, source: { conversationId: string; message: PlatformMessageRef; capabilities?: CapabilitySet }): Promise<void> {
    const task = this.getTask(taskId);
    if (!task.capabilities.tasks.canFollowUp || this.isTerminalTask(task.status) || this.cancellationRequested(taskId)) throw new Error("TASK_FOLLOW_UP_DENIED");
    if (source.capabilities) {
      const actor = validateCapabilitySet(source.capabilities);
      if (!actor.tasks.canFollowUp || !actor.qq.sendConversations.includes(source.conversationId)) throw new Error("TASK_FOLLOW_UP_DENIED");
    }
    const targetWorker = this.db.get<{ id: string }>("SELECT id FROM worker_executions WHERE task_id=? AND status IN ('PENDING','STARTING','RUNNING','WAITING_USER') ORDER BY CASE status WHEN 'RUNNING' THEN 0 WHEN 'WAITING_USER' THEN 1 WHEN 'STARTING' THEN 2 ELSE 3 END, updated_at DESC LIMIT 1", taskId);
    const id = newId("mail");
    this.db.transaction(() => {
      this.db.run("INSERT INTO task_mailbox(id,task_id,type,source_conversation_id,source_message_key,content,status,created_at,worker_id) VALUES (?,?,?,?,?,?,?,?,?)", id, taskId, "FOLLOW_UP", source.conversationId, messageKey(source.message), content, "PENDING", nowIso(), targetWorker?.id ?? null);
      this.event(taskId, "FOLLOW_UP_ADDED", undefined, { mailboxId: id });
    });
    if (targetWorker) {
      const session = this.activeSessions.get(targetWorker.id);
      try {
        if (!session) throw new Error("WORKER_SESSION_UNAVAILABLE");
        const output = await this.pi.steer(session, `Additional user instruction: ${content}`, { timeoutMs: this.config.runtime.piTimeoutMs });
        this.db.run("UPDATE task_mailbox SET status='DELIVERED',delivered_at=? WHERE id=? AND status IN ('PENDING','DELIVERED')", nowIso(), id);
        await this.handleWorkerOutput(targetWorker.id, output);
        this.markMailboxConsumed(id);
      } catch (error) { this.recordException(taskId, targetWorker.id, "addFollowUp", "WORKER_DELIVERY", String(error)); }
    }
  }

  async requestCancel(taskId: string, actor?: CapabilitySet): Promise<void> {
    const task = this.getTask(taskId);
    if (actor) {
      const checked = validateCapabilitySet(actor);
      if (!checked.tasks.canCancel) throw new Error("TASK_CANCEL_DENIED");
      if (!this.taskVisibleToActor(task, checked)) throw new Error("TASK_CANCEL_DENIED");
    }
    if (!task.capabilities.tasks.canCancel) throw new Error("TASK_CANCEL_DENIED");
    if (this.isTerminalTask(task.status)) throw new Error("TASK_CANCEL_DENIED");
    const workers = this.db.all<{ id: string; status: WorkerStatus; workspace_id: string | null; harness_session_id: string | null; harness_session_path: string | null; process_id: number | null; process_group_id: number | null; pid_start_time: string | null }>("SELECT w.id,w.status,w.workspace_id,w.harness_session_id,w.harness_session_path,w.process_id,op.process_group_id,op.pid_start_time FROM worker_executions w LEFT JOIN owned_processes op ON op.worker_id=w.id WHERE w.task_id=? AND w.status IN ('PENDING','STARTING','RUNNING','WAITING_USER','STOPPING')", taskId);
    this.db.transaction(() => {
      this.event(taskId, "CANCEL_REQUESTED");
      this.db.run("UPDATE pending_questions SET status='CLOSED',closed_at=? WHERE task_id=? AND status='OPEN'", nowIso(), taskId);
      for (const worker of workers) {
        const update = this.db.run("UPDATE worker_executions SET status='STOPPING',updated_at=? WHERE id=? AND status IN ('PENDING','STARTING','RUNNING','WAITING_USER','STOPPING')", nowIso(), worker.id);
        if (update.changes > 0) this.event(taskId, "WORKER_STOPPING", worker.id);
      }
    });
    let confirmed = true;
    for (const worker of workers) {
      if (!(await this.stopWorkerExecution(worker))) confirmed = false;
    }
    if (!confirmed) { this.recordException(taskId, undefined, "cancel", "PROCESS_STATE_UNKNOWN", "Worker termination could not be confirmed"); return; }
    const timestamp = nowIso();
    this.db.transaction(() => {
      for (const worker of workers) {
        const update = this.db.run("UPDATE worker_executions SET status='CANCELLED',finished_at=?,updated_at=? WHERE id=? AND status='STOPPING'", timestamp, timestamp, worker.id);
        if (update.changes === 0) continue;
        if (worker.workspace_id) this.db.run("DELETE FROM project_locks WHERE project_id=? AND owner_worker_id=?", worker.workspace_id, worker.id);
        this.db.run("DELETE FROM owned_processes WHERE worker_id=?", worker.id);
        this.db.run("UPDATE pending_questions SET status='CLOSED',closed_at=? WHERE worker_id=? AND status='OPEN'", timestamp, worker.id);
        this.event(taskId, "WORKER_CANCELLED", worker.id);
      }
      const active = Number(this.db.get<{ count: number }>("SELECT count(*) AS count FROM worker_executions WHERE task_id=? AND status IN ('PENDING','STARTING','RUNNING','WAITING_USER','STOPPING')", taskId)?.count ?? 0);
      if (active === 0) {
        const update = this.db.run("UPDATE tasks SET status='CANCELLED',completed_at=?,updated_at=? WHERE id=? AND status NOT IN ('COMPLETED','PARTIAL','FAILED','CANCELLED')", timestamp, timestamp, taskId);
        if (update.changes > 0) this.event(taskId, "TASK_CANCELLED");
      }
    });
    for (const worker of workers) await this.revokeWorkerBinding(worker.id);
  }

  async quiesceForBackup(): Promise<void> {
    const workers = this.db.all<{ id: string; task_id: string; workspace_id: string | null; harness_session_id: string | null; harness_session_path: string | null; process_id: number | null; process_group_id: number | null; pid_start_time: string | null }>("SELECT w.id,w.task_id,w.workspace_id,w.harness_session_id,w.harness_session_path,w.process_id,op.process_group_id,op.pid_start_time FROM worker_executions w LEFT JOIN owned_processes op ON op.worker_id=w.id WHERE w.status IN ('PENDING','STARTING','RUNNING','WAITING_USER','STOPPING')");
    for (const worker of workers) {
      if (!await this.stopWorkerExecution(worker)) throw new Error(`BACKUP_WORKER_TERMINATION_UNCONFIRMED:${worker.id}`);
    }
    const timestamp = nowIso();
    this.db.transaction(() => {
      for (const worker of workers) {
        const update = this.db.run("UPDATE worker_executions SET status='INTERRUPTED',finished_at=?,updated_at=? WHERE id=? AND status IN ('PENDING','STARTING','RUNNING','WAITING_USER','STOPPING')", timestamp, timestamp, worker.id);
        if (update.changes === 0) continue;
        if (worker.workspace_id) this.db.run("DELETE FROM project_locks WHERE project_id=? AND owner_worker_id=?", worker.workspace_id, worker.id);
        this.db.run("DELETE FROM owned_processes WHERE worker_id=?", worker.id);
        this.db.run("UPDATE pending_questions SET status='CLOSED',closed_at=? WHERE worker_id=? AND status='OPEN'", timestamp, worker.id);
        this.event(worker.task_id, "WORKER_INTERRUPTED", worker.id, { reason: "backup" });
        this.event(worker.task_id, "TASK_INTERRUPTED", worker.id, { reason: "backup" });
        this.db.run("UPDATE tasks SET status='INTERRUPTED',updated_at=? WHERE id=? AND status NOT IN ('COMPLETED','PARTIAL','FAILED','CANCELLED')", timestamp, worker.task_id);
        this.activeSessions.delete(worker.id);
      }
    });
    for (const worker of workers) await this.revokeWorkerBinding(worker.id);
  }

  async finishWorker(workerId: string, result: { outcome: "COMPLETED" | "PARTIAL" | "FAILED"; summary: string; artifacts?: string[] }): Promise<void> {
    const worker = this.getWorker(workerId);
    if (!["STARTING", "RUNNING", "WAITING_USER"].includes(worker.status) || this.cancellationRequested(worker.taskId)) return;
    const status: WorkerStatus = result.outcome === "COMPLETED" ? "COMPLETED" : result.outcome === "PARTIAL" ? "COMPLETED" : "FAILED";
    const timestamp = nowIso();
    const finished = this.db.transaction(() => {
      const update = this.db.run("UPDATE worker_executions SET status=?,finished_at=?,updated_at=? WHERE id=? AND status IN ('STARTING','RUNNING','WAITING_USER')", status, timestamp, timestamp, workerId);
      if (update.changes === 0) return false;
      if (worker.workspaceId) this.db.run("DELETE FROM project_locks WHERE project_id=? AND owner_worker_id=?", worker.workspaceId, workerId);
      this.db.run("DELETE FROM owned_processes WHERE worker_id=?", workerId);
      this.event(worker.taskId, "WORKER_COMPLETED", workerId, { outcome: result.outcome, summary: result.summary, artifacts: result.artifacts ?? [] });
      this.event(worker.taskId, "TASK_RESULT", workerId, { outcome: result.outcome, summary: result.summary, artifacts: result.artifacts ?? [] });
      const remaining = Number(this.db.get<{ count: number }>("SELECT count(*) AS count FROM worker_executions WHERE task_id=? AND status IN ('PENDING','STARTING','RUNNING','WAITING_USER','STOPPING')", worker.taskId)?.count ?? 0);
      if (remaining === 0) {
        // A Worker result is evidence for Main, not a Task-level completion
        // decision. Keep the Task alive until finishTask() is called.
        this.db.run("UPDATE tasks SET status='RUNNING',updated_at=? WHERE id=?", timestamp, worker.taskId);
        this.event(worker.taskId, "TASK_AWAITING_COMPLETION", undefined, { outcome: result.outcome });
      } else {
        this.db.run("UPDATE tasks SET status='RUNNING',updated_at=? WHERE id=?", timestamp, worker.taskId);
      }
      return true;
    });
    if (!finished) return;
    this.activeSessions.delete(workerId);
    await this.revokeWorkerBinding(workerId);
    const task = this.getTask(worker.taskId);
    await this.emit({ type: "TASK_RESULT", taskId: task.id, workerId, payload: { ...result } });
    void this.schedulePendingWorkers(task.id);
  }

  workerControl(workerId: string): WorkerControl {
    return {
      reportProgress: (input) => this.reportProgress(workerId, input.summary, input.currentAction ? `${input.currentAction}${input.completedSteps?.length ? `; completed: ${input.completedSteps.join(", ")}` : ""}` : input.completedSteps?.join(", ")),
      askParent: async (input) => ({ questionId: await this.askParent(workerId, input.question) }),
      publishArtifact: async (input) => {
        const worker = this.getWorker(workerId);
        const artifactCapability = worker.capabilities?.artifacts;
        if (!artifactCapability || (!artifactCapability.publishTaskIds.includes(worker.taskId) && !artifactCapability.publishTaskIds.includes("*"))) throw new Error("ARTIFACT_PUBLISH_DENIED");
        const workspace = this.workerWorkspace(worker);
        const artifact = await this.artifacts.registerLocalArtifact({
          path: resolve(workspace, input.path),
          taskId: worker.taskId,
          workerId,
          mime: input.mime,
          sourceType: "WORKER_OUTPUT",
          allowedRoots: [workspace],
          capability: artifactCapability,
          maxBytes: this.config.runtime.maxArtifactBytes,
        });
        return { artifactId: artifact.ref.artifactId, filename: artifact.filename, size: artifact.size };
      },
      finishTask: async (input) => {
        const worker = this.getWorker(workerId);
        const artifacts = this.validateWorkerArtifacts(worker.taskId, input.artifacts ?? []);
        await this.finishWorker(workerId, { ...input, artifacts });
      },
    };
  }

  async finishTask(taskId: string, result: { outcome: "COMPLETED" | "PARTIAL" | "FAILED"; summary: string; artifacts?: string[] }, workerId?: string): Promise<void> {
    if (workerId) { await this.finishWorker(workerId, result); return; }
    const task = this.getTask(taskId);
    if (this.isTerminalTask(task.status) || this.cancellationRequested(taskId)) return;
    const active = Number(this.db.get<{ count: number }>("SELECT count(*) AS count FROM worker_executions WHERE task_id=? AND status IN ('PENDING','STARTING','RUNNING','WAITING_USER','STOPPING')", taskId)?.count ?? 0);
    if (active > 0) throw new Error("TASK_WORKERS_STILL_ACTIVE");
    const activeChildren = Number(this.db.get<{ count: number }>("SELECT count(*) AS count FROM tasks WHERE parent_task_id=? AND status IN ('CREATED','QUEUED','RUNNING','WAITING_USER','PAUSED','INTERRUPTED')", taskId)?.count ?? 0);
    if (activeChildren > 0) throw new Error("TASK_CHILDREN_STILL_ACTIVE");
    const artifacts = result.artifacts ? this.validateWorkerArtifacts(taskId, result.artifacts) : undefined;
    const finalResult = { ...result, ...(artifacts ? { artifacts } : {}) };
    const timestamp = nowIso();
    const status: TaskStatus = result.outcome === "COMPLETED" ? "COMPLETED" : result.outcome === "PARTIAL" ? "PARTIAL" : "FAILED";
    this.db.transaction(() => {
      const update = this.db.run("UPDATE tasks SET status=?,completed_at=?,updated_at=? WHERE id=? AND status NOT IN ('COMPLETED','PARTIAL','FAILED','CANCELLED')", status, timestamp, timestamp, taskId);
      if (update.changes > 0) {
        this.event(taskId, "TASK_FINISHED", undefined, { ...finalResult });
        this.event(taskId, "TASK_RESULT", undefined, { ...finalResult });
      }
    });
    await this.emit({ type: "TASK_RESULT", taskId, payload: { ...finalResult } });
  }

  async failWorker(workerId: string, error: string): Promise<void> {
    const worker = this.getWorker(workerId);
    if (!["STARTING", "RUNNING", "WAITING_USER"].includes(worker.status) || this.cancellationRequested(worker.taskId)) return;
    const session = this.activeSessions.get(workerId);
    if (session && !(await this.pi.abort(session))) {
      const timestamp = nowIso();
      this.db.run("UPDATE worker_executions SET status='STOPPING',updated_at=? WHERE id=? AND status IN ('STARTING','RUNNING','WAITING_USER')", timestamp, workerId);
      this.recordException(worker.taskId, workerId, "worker", "PROCESS_STATE_UNKNOWN", "Worker failure did not confirm Pi termination");
      return;
    }
    const timestamp = nowIso();
    const failed = this.db.transaction(() => {
      const update = this.db.run("UPDATE worker_executions SET status='FAILED',finished_at=?,updated_at=? WHERE id=? AND status IN ('STARTING','RUNNING','WAITING_USER')", timestamp, timestamp, workerId);
      if (update.changes === 0) return false;
      if (worker.workspaceId) this.db.run("DELETE FROM project_locks WHERE project_id=? AND owner_worker_id=?", worker.workspaceId, workerId);
      this.db.run("DELETE FROM owned_processes WHERE worker_id=?", workerId);
      this.event(worker.taskId, "WORKER_FAILED", workerId, { error: error.slice(0, 1000) });
      this.event(worker.taskId, "TASK_RESULT", workerId, { outcome: "FAILED", summary: "Worker failed." });
      this.db.run("UPDATE tasks SET status='RUNNING',updated_at=? WHERE id=?", timestamp, worker.taskId);
      this.event(worker.taskId, "TASK_AWAITING_COMPLETION", undefined, { outcome: "FAILED" });
      return true;
    });
    if (!failed) return;
    this.activeSessions.delete(workerId);
    await this.revokeWorkerBinding(workerId);
    this.recordException(worker.taskId, workerId, "worker", "PI_FAILURE", error);
    await this.emit({ type: "TASK_RESULT", taskId: worker.taskId, workerId, payload: { outcome: "FAILED", summary: "Worker failed." } });
    void this.schedulePendingWorkers(worker.taskId);
  }

  private async stopWorkerExecution(worker: { id: string; harness_session_id: string | null; harness_session_path: string | null; process_id: number | null; process_group_id: number | null; pid_start_time: string | null }): Promise<boolean> {
    const active = this.activeSessions.get(worker.id);
    if (active) return this.pi.abort(active);
    if (!worker.process_id) return true;
    if (!worker.harness_session_id || !worker.process_group_id || !worker.pid_start_time || !this.pi.terminateProcess) return false;
    return this.pi.terminateProcess(
      { sessionId: worker.harness_session_id, sessionPath: worker.harness_session_path ?? this.workerSessionPath(worker.id) },
      { pid: worker.process_id, processGroupId: worker.process_group_id, startTime: worker.pid_start_time },
    );
  }

  async recover(): Promise<void> {
    const active = this.db.all<{
      id: string; task_id: string; workspace_id: string | null; harness_session_id: string | null; harness_session_path: string | null;
      process_id: number | null; status: WorkerStatus; owned_pid: number | null;
      process_group_id: number | null; pid_start_time: string | null;
    }>("SELECT w.id,w.task_id,w.workspace_id,w.harness_session_id,w.harness_session_path,w.process_id,w.status,op.pid AS owned_pid,op.process_group_id,op.pid_start_time FROM worker_executions w LEFT JOIN owned_processes op ON op.worker_id=w.id WHERE w.status IN ('STARTING','RUNNING','WAITING_USER','STOPPING')");
    for (const worker of active) {
      const session = worker.harness_session_id ? { sessionId: worker.harness_session_id, sessionPath: await this.recoverySessionPath(worker.id, worker.harness_session_path) } : undefined;
      const expected = worker.owned_pid && worker.process_group_id && worker.pid_start_time
        ? { pid: worker.owned_pid, processGroupId: worker.process_group_id, startTime: worker.pid_start_time }
        : undefined;
      const processState = await this.recoveryProcessState(session, expected, worker.process_id);

      if (worker.status === "STOPPING") {
        if (processState === "OWNED" && expected && session && this.pi.terminateProcess) {
          const terminated = await this.pi.terminateProcess(session, expected);
          if (!terminated) {
            this.recordException(worker.task_id, worker.id, "recovery", "PROCESS_STATE_UNKNOWN", "Stopping Worker process could not be terminated safely");
            continue;
          }
        } else if (processState === "FOREIGN" || processState === "UNKNOWN" || (processState === "OWNED" && !this.pi.terminateProcess)) {
          this.recordException(worker.task_id, worker.id, "recovery", "PROCESS_STATE_UNKNOWN", `Worker ${worker.id} cancellation process state could not be confirmed`);
          continue;
        }
        this.finalizeRecoveredCancellation(worker.task_id, worker.id, worker.workspace_id);
        continue;
      }

      if (worker.status === "WAITING_USER") {
        if (processState === "OWNED" && expected && session && this.pi.terminateProcess) {
          const terminated = await this.pi.terminateProcess(session, expected);
          if (!terminated) {
            this.recordException(worker.task_id, worker.id, "recovery", "PROCESS_STATE_UNKNOWN", "Owned Pi process could not be terminated safely");
            continue;
          }
        } else if (processState === "FOREIGN" || processState === "UNKNOWN") {
          this.recordException(worker.task_id, worker.id, "recovery", "PROCESS_STATE_UNKNOWN", `Worker ${worker.id} process ownership could not be confirmed`);
          continue;
        }
        if (session && await this.restoreRecoveredSession(worker.id, worker.task_id, worker.workspace_id, "WAITING_USER", session)) {
          this.db.run("UPDATE tasks SET status='WAITING_USER',updated_at=? WHERE id=?", nowIso(), worker.task_id);
          await this.replayPendingMailbox(worker.id, session);
          continue;
        }
        this.interruptRecoveredWorker(worker.task_id, worker.id, worker.workspace_id, "session_unavailable", true);
        continue;
      }

      if (processState === "OWNED" && expected && session && this.pi.terminateProcess) {
        const terminated = await this.pi.terminateProcess(session, expected);
        if (!terminated) {
          this.recordException(worker.task_id, worker.id, "recovery", "PROCESS_STATE_UNKNOWN", "Owned Pi process could not be terminated safely");
          continue;
        }
        this.recordException(worker.task_id, worker.id, "recovery", "ORPHAN_PROCESS", `terminated owned process ${expected.pid} after Runtime restart`);
      } else if (processState === "FOREIGN" || processState === "UNKNOWN") {
        this.recordException(worker.task_id, worker.id, "recovery", "PROCESS_STATE_UNKNOWN", `Worker ${worker.id} process ownership could not be confirmed`);
        this.interruptRecoveredWorker(worker.task_id, worker.id, worker.workspace_id, "process_state_unknown", false);
        continue;
      }
      if (session && await this.restoreRecoveredSession(worker.id, worker.task_id, worker.workspace_id, "RUNNING", session)) {
        this.db.run("UPDATE tasks SET status='RUNNING',updated_at=? WHERE id=?", nowIso(), worker.task_id);
        await this.replayPendingMailbox(worker.id, session);
        continue;
      }
      this.interruptRecoveredWorker(worker.task_id, worker.id, worker.workspace_id, "runtime_restart", true);
    }
    this.reconcileProjectLocks();
    await this.schedulePendingWorkers();
  }

  private async recoveryProcessState(session: PiSession | undefined, expected: PiProcessIdentity | undefined, processId: number | null): Promise<"OWNED" | "NOT_FOUND" | "FOREIGN" | "UNKNOWN"> {
    if (!processId) return "NOT_FOUND";
    if (!session || !expected || !this.pi.inspectProcess) return this.processAlive(processId) ? "UNKNOWN" : "NOT_FOUND";
    return this.pi.inspectProcess(session, expected);
  }

  private async restoreRecoveredSession(workerId: string, taskId: string, workspaceId: string | null, status: "RUNNING" | "WAITING_USER", session: PiSession): Promise<boolean> {
    const worker = this.getWorker(workerId);
    const projectPath = workspaceId ? join(this.options.workerRoot, "projects", this.canonicalWorkspaceId(workspaceId)) : join(this.options.workerRoot, "scratch", workerId);
    const mcpToken = await this.ensureWorkerBinding(workerId);
    const sandbox: PiSandbox = { workspaceRoot: projectPath, sessionRoot: dirname(session.sessionPath), writeAccess: workspaceId ? worker.workspaceAccess === "WRITE" : false, ...(mcpToken && this.options.mcpEndpoint ? { mcpEndpoint: this.options.mcpEndpoint, mcpToken } : {}) };
    if (!await this.pi.resumeSession(session, { cwd: projectPath, sandbox, ...(this.options.workerToolExtensionPath && mcpToken ? { extensionPath: this.options.workerToolExtensionPath } : {}) })) return false;
    this.activeSessions.set(workerId, session);
    const identity = await this.pi.processInfo?.(session);
    this.db.transaction(() => {
      this.db.run("UPDATE worker_executions SET status=?,harness_session_path=?,process_id=?,updated_at=? WHERE id=?", status, session.sessionPath, identity?.pid ?? null, nowIso(), workerId);
      this.db.run("DELETE FROM owned_processes WHERE worker_id=?", workerId);
      if (identity) this.db.run("INSERT INTO owned_processes(id,task_id,worker_id,pid,process_group_id,command_summary,started_at,pid_start_time) VALUES (?,?,?,?,?,?,?,?)", `process-${workerId}`, taskId, workerId, identity.pid, identity.processGroupId, "pi --mode rpc --session", nowIso(), identity.startTime);
      this.event(taskId, "WORKER_RECOVERED", workerId, { status, sessionId: session.sessionId });
    });
    return true;
  }

  private interruptRecoveredWorker(taskId: string, workerId: string, workspaceId: string | null, reason: string, releaseLock: boolean): void {
    const timestamp = nowIso();
    this.db.transaction(() => {
      this.db.run("UPDATE worker_executions SET status='INTERRUPTED',updated_at=? WHERE id=?", timestamp, workerId);
      if (releaseLock) this.db.run("DELETE FROM owned_processes WHERE worker_id=?", workerId);
      if (releaseLock && workspaceId) this.db.run("DELETE FROM project_locks WHERE project_id=? AND owner_worker_id=?", workspaceId, workerId);
      this.db.run("UPDATE pending_questions SET status='CLOSED',closed_at=? WHERE worker_id=? AND status='OPEN'", timestamp, workerId);
      this.event(taskId, "WORKER_INTERRUPTED", workerId, { reason });
      this.event(taskId, "TASK_INTERRUPTED", workerId, { reason });
      this.db.run("UPDATE tasks SET status='INTERRUPTED',updated_at=? WHERE id=? AND status NOT IN ('COMPLETED','PARTIAL','FAILED','CANCELLED')", timestamp, taskId);
    });
    void this.emit({ type: "TASK_INTERRUPTED", taskId, workerId, payload: { reason } });
  }

  private finalizeRecoveredCancellation(taskId: string, workerId: string, workspaceId: string | null): void {
    const timestamp = nowIso();
    this.db.transaction(() => {
      const update = this.db.run("UPDATE worker_executions SET status='CANCELLED',finished_at=?,updated_at=? WHERE id=? AND status='STOPPING'", timestamp, timestamp, workerId);
      if (update.changes === 0) return;
      if (workspaceId) this.db.run("DELETE FROM project_locks WHERE project_id=? AND owner_worker_id=?", workspaceId, workerId);
      this.db.run("DELETE FROM owned_processes WHERE worker_id=?", workerId);
      this.db.run("UPDATE pending_questions SET status='CLOSED',closed_at=? WHERE worker_id=? AND status='OPEN'", timestamp, workerId);
      this.event(taskId, "WORKER_CANCELLED", workerId, { recovered: true });
      const active = Number(this.db.get<{ count: number }>("SELECT count(*) AS count FROM worker_executions WHERE task_id=? AND status IN ('PENDING','STARTING','RUNNING','WAITING_USER','STOPPING')", taskId)?.count ?? 0);
      if (active === 0) {
        const taskUpdate = this.db.run("UPDATE tasks SET status='CANCELLED',completed_at=?,updated_at=? WHERE id=? AND status NOT IN ('COMPLETED','PARTIAL','FAILED','CANCELLED')", timestamp, timestamp, taskId);
        if (taskUpdate.changes > 0) this.event(taskId, "TASK_CANCELLED");
      }
    });
  }

  private reconcileProjectLocks(): void {
    const rows = this.db.all<{ project_id: string; owner_worker_id: string; worker_status: WorkerStatus | null }>("SELECT l.project_id,l.owner_worker_id,w.status AS worker_status FROM project_locks l LEFT JOIN worker_executions w ON w.id=l.owner_worker_id");
    for (const row of rows) {
      if (!row.worker_status || ["COMPLETED", "FAILED", "CANCELLED"].includes(row.worker_status)) this.db.run("DELETE FROM project_locks WHERE project_id=? AND owner_worker_id=?", row.project_id, row.owner_worker_id);
    }
  }

  private async replayPendingMailbox(workerId: string, session: PiSession): Promise<void> {
    const rows = this.db.all<{ id: string; task_id: string; content: string | null; question_id: string | null }>("SELECT id,task_id,content,question_id FROM task_mailbox WHERE worker_id=? AND status IN ('PENDING','DELIVERED') ORDER BY created_at,id", workerId);
    for (const row of rows) {
      try {
        const output = await this.pi.steer(session, `Durable pending Worker mailbox item: ${row.content ?? ""}`, { timeoutMs: this.config.runtime.piTimeoutMs });
        const timestamp = nowIso();
        this.db.transaction(() => {
          this.db.run("UPDATE task_mailbox SET status='DELIVERED',delivered_at=? WHERE id=? AND status IN ('PENDING','DELIVERED')", timestamp, row.id);
          if (row.question_id) this.db.run("UPDATE pending_questions SET status='CLOSED',closed_at=? WHERE id=? AND status='ANSWERED'", timestamp, row.question_id);
          this.db.run("UPDATE worker_executions SET status='RUNNING',updated_at=? WHERE id=?", timestamp, workerId);
          this.db.run("UPDATE tasks SET status='RUNNING',updated_at=? WHERE id=?", timestamp, row.task_id);
        });
        await this.handleWorkerOutput(workerId, output);
        this.markMailboxConsumed(row.id);
      } catch (error) {
        this.recordException(row.task_id, workerId, "recovery_mailbox", "WORKER_DELIVERY", String(error));
      }
    }
  }

  private markMailboxConsumed(mailboxId: string): void {
    this.db.run("UPDATE task_mailbox SET status='CONSUMED',consumed_at=? WHERE id=? AND status='DELIVERED'", nowIso(), mailboxId);
  }

  private async ensureWorkerBinding(workerId: string): Promise<string | undefined> {
    if (!this.options.mcpControl || !this.options.mcpEndpoint || !this.options.workerToolExtensionPath) return undefined;
    const worker = this.getWorker(workerId);
    const existing = this.db.get<{ mcp_binding_token: string | null }>("SELECT mcp_binding_token FROM worker_executions WHERE id=?", workerId)?.mcp_binding_token;
    const token = existing ?? randomBytes(32).toString("hex");
    if (!existing) this.db.run("UPDATE worker_executions SET mcp_binding_token=?,updated_at=? WHERE id=?", token, nowIso(), workerId);
    await this.options.mcpControl.registerWorkerBinding({ token, taskId: worker.taskId, workerId, allowedActions: worker.capabilities?.plugins.allowedActions ?? [] });
    return token;
  }

  private async revokeWorkerBinding(workerId: string): Promise<void> {
    if (!this.options.mcpControl) return;
    const token = this.db.get<{ mcp_binding_token: string | null }>("SELECT mcp_binding_token FROM worker_executions WHERE id=?", workerId)?.mcp_binding_token;
    if (!token) return;
    try { await this.options.mcpControl.unregisterWorkerBinding(token); }
    catch (error) { this.log.warn("Worker MCP binding revoke failed", { workerId, error: String(error) }); }
    this.db.run("UPDATE worker_executions SET mcp_binding_token=NULL,updated_at=? WHERE id=?", nowIso(), workerId);
  }

  private async schedulePendingWorkers(taskId?: string): Promise<void> {
    const rows = this.db.all<{ id: string; task_id: string; workspace_id: string | null; workspace_access: WorkerExecutionRecord["workspaceAccess"] }>(
      taskId
        ? "SELECT id,task_id,workspace_id,workspace_access FROM worker_executions WHERE task_id=? AND status='PENDING' ORDER BY updated_at,id"
        : "SELECT id,task_id,workspace_id,workspace_access FROM worker_executions WHERE status='PENDING' ORDER BY updated_at,id",
      ...(taskId ? [taskId] : []),
    );
    for (const worker of rows) {
      const active = Number(this.db.get<{ count: number }>("SELECT count(*) AS count FROM worker_executions WHERE task_id=? AND status IN ('STARTING','RUNNING','WAITING_USER','STOPPING')", worker.task_id)?.count ?? 0);
      if (active >= this.config.runtime.maxWorkers) continue;
      if (worker.workspace_access === "WRITE" && worker.workspace_id && !this.tryAcquireLock(worker.workspace_id, worker.id)) continue;
      const timestamp = nowIso();
      const changed = this.db.transaction(() => {
        const update = this.db.run("UPDATE worker_executions SET status='STARTING',updated_at=? WHERE id=? AND status='PENDING'", timestamp, worker.id);
        if (update.changes === 0) return false;
        this.db.run("UPDATE tasks SET status='RUNNING',updated_at=? WHERE id=? AND status IN ('QUEUED','CREATED','INTERRUPTED')", timestamp, worker.task_id);
        this.event(worker.task_id, "WORKER_SCHEDULED", worker.id);
        return true;
      });
      if (changed) void this.startWorker(worker.id).catch((error) => this.log.error("Pending Worker startup failed", { workerId: worker.id, error: String(error) }));
    }
  }

  getTask(taskId: string): TaskRecord {
    const row = this.db.get<Record<string, unknown>>("SELECT * FROM tasks WHERE id=?", taskId);
    if (!row) throw new Error("TASK_NOT_FOUND");
    let capabilities: CapabilitySet;
    try { capabilities = validateCapabilitySet(JSON.parse(row.capabilities_json as string)); } catch { throw new Error("CAPABILITY_SNAPSHOT_INVALID"); }
    return { id: row.id as string, title: row.title as string, goal: row.goal as string, status: row.status as TaskStatus, requester: JSON.parse(row.requester_json as string) as TaskRequester, trust: row.trust as TaskRecord["trust"], originConversationId: row.origin_conversation_id as string, notificationConversationId: row.notification_conversation_id as string, ...(row.parent_task_id ? { parentTaskId: row.parent_task_id as string } : {}), capabilities, createdAt: row.created_at as string, updatedAt: row.updated_at as string, ...(row.completed_at ? { completedAt: row.completed_at as string } : {}) };
  }

  getWorker(workerId: string): WorkerExecutionRecord {
    const row = this.db.get<Record<string, unknown>>("SELECT * FROM worker_executions WHERE id=?", workerId);
    if (!row) throw new Error("WORKER_NOT_FOUND");
    let capabilities: CapabilitySet | undefined;
    if (typeof row.capabilities_json === "string") {
      try { capabilities = validateCapabilitySet(JSON.parse(row.capabilities_json)); } catch { this.log.warn("Worker capability snapshot is invalid", { workerId }); }
    }
    let artifactRefs: ArtifactRef[] | undefined;
    if (typeof row.artifact_refs_json === "string") {
      try { artifactRefs = JSON.parse(row.artifact_refs_json) as ArtifactRef[]; } catch { this.log.warn("Worker artifact reference snapshot is invalid", { workerId }); }
    }
    return { id: row.id as string, taskId: row.task_id as string, objective: row.objective as string, status: row.status as WorkerStatus, harness: "pi", ...(row.harness_session_id ? { harnessSessionId: row.harness_session_id as string } : {}), ...(row.workspace_id ? { workspaceId: row.workspace_id as string } : {}), ...(row.workspace_access ? { workspaceAccess: row.workspace_access as "READ" | "WRITE" } : {}), ...(capabilities ? { capabilities } : {}), ...(artifactRefs?.length ? { artifactRefs } : {}), ...(row.process_id ? { processId: row.process_id as number } : {}), ...(row.started_at ? { startedAt: row.started_at as string } : {}), updatedAt: row.updated_at as string, ...(row.finished_at ? { finishedAt: row.finished_at as string } : {}) };
  }

  listTasks(conversationId?: string, capabilities?: CapabilitySet, requesterId?: string, requesterPrincipalId?: string): TaskRecord[] {
    const visibleIds = capabilities?.tasks.visibleTaskIds ?? [];
    const rows = conversationId
      ? this.db.all<{ id: string }>(`SELECT id FROM tasks WHERE origin_conversation_id=? OR notification_conversation_id=?${visibleIds.length ? ` OR id IN (${visibleIds.map(() => "?").join(",")})` : ""} ORDER BY updated_at DESC`, conversationId, conversationId, ...visibleIds)
      : this.db.all<{ id: string }>("SELECT id FROM tasks ORDER BY updated_at DESC");
    return rows.map((row) => this.getTask(row.id)).filter((task) => {
      if (!capabilities) return true;
      if (visibleIds.includes(task.id)) return true;
      if (conversationId && task.originConversationId !== conversationId && task.notificationConversationId !== conversationId) return false;
      return task.requester.userId === requesterId || (requesterPrincipalId !== undefined && task.requester.principalId === requesterPrincipalId);
    });
  }

  getProgress(taskId: string): string[] {
    return this.db.all<{ payload_json: string }>("SELECT payload_json FROM task_events WHERE task_id=? AND type='WORKER_PROGRESS' ORDER BY created_at DESC LIMIT 10", taskId).map((row) => (JSON.parse(row.payload_json) as { summary?: string }).summary ?? "");
  }

  private async emit(event: RuntimeEvent): Promise<void> {
    let task: TaskRecord | undefined;
    try { task = event.taskId ? this.getTask(event.taskId) : undefined; }
    catch (error) { this.log.warn("Task event could not load its durable Task", { taskId: event.taskId, error: String(error) }); return; }
    if (task) await this.options.onEvent?.(event, task);
  }

  private event(taskId: string, type: string, workerId?: string, payload: Record<string, unknown> = {}): void {
    const eventId = newId("taskevt");
    const createdAt = nowIso();
    this.db.run("INSERT INTO task_events(id,task_id,worker_id,type,payload_json,created_at) VALUES (?,?,?,?,?,?)", eventId, taskId, workerId ?? null, type, JSON.stringify(payload), createdAt);
    if (MAIN_EVENT_TYPES.has(type)) {
      this.db.run("INSERT INTO task_event_outbox(task_event_id,task_id,event_type,question_id,payload_json,status,attempts,created_at) VALUES (?,?,?,?,?,?,?,?)", eventId, taskId, type, typeof payload.questionId === "string" ? payload.questionId : null, JSON.stringify(payload), "PENDING", 0, createdAt);
    }
  }

  private recordException(taskId: string, workerId: string | undefined, operation: string, category: string, summary: string): void {
    const bounded = summary.slice(0, 2000);
    this.db.run("INSERT INTO runtime_exceptions(id,task_id,worker_id,operation,category,summary,created_at) VALUES (?,?,?,?,?,?,?)", newId("exception"), taskId, workerId ?? null, operation, category, bounded, nowIso());
    this.event(taskId, "TASK_EXCEPTION", workerId, { operation, category, summary: bounded });
    void this.emit({ type: "TASK_EXCEPTION", taskId, workerId, payload: { operation, category, summary: bounded } });
  }

  private tryAcquireLock(projectId: string, workerId: string): boolean {
    try { this.db.run("INSERT INTO project_locks(project_id,mode,owner_worker_id,acquired_at) VALUES (?,?,?,?)", projectId, "WRITE", workerId, nowIso()); return true; } catch { return false; }
  }

  private hasLock(projectId: string, workerId: string): boolean { return Boolean(this.db.get("SELECT 1 AS found FROM project_locks WHERE project_id=? AND owner_worker_id=?", projectId, workerId)); }

  private processAlive(pid: number): boolean {
    try { process.kill(pid, 0); return true; } catch { return false; }
  }

  private async handleWorkerOutput(workerId: string, output: string): Promise<void> {
    const parsed = this.parseWorkerOutput(output);
    const control = this.workerControl(workerId);
    const published: string[] = [];
    let asked = false;
    let finished = false;
    for (const frame of parsed.frames) {
      if (frame.type === "progress") await control.reportProgress(frame);
      else if (frame.type === "question") { await control.askParent(frame); asked = true; }
      else if (frame.type === "artifact") published.push((await control.publishArtifact(frame)).artifactId);
      else {
        if (finished) throw new Error("WORKER_MULTIPLE_FINISH_FRAMES");
        await control.finishTask({ ...frame, artifacts: [...published, ...(frame.artifacts ?? [])] });
        finished = true;
      }
    }
    if (asked || finished || (parsed.frames.length > 0 && !parsed.text.trim())) return;
    const summary = parsed.text.trim();
    if (summary) await control.finishTask({ outcome: "COMPLETED", summary, artifacts: published });
    else throw new Error("WORKER_NO_RESULT");
  }

  private parseWorkerOutput(output: string): { frames: WorkerControlFrame[]; text: string } {
    const frames: WorkerControlFrame[] = [];
    const text: string[] = [];
    for (const line of output.split(/\r?\n/)) {
      if (!line.startsWith(WORKER_CONTROL_PREFIX)) { text.push(line); continue; }
      let value: unknown;
      try { value = JSON.parse(line.slice(WORKER_CONTROL_PREFIX.length)); } catch { throw new Error("WORKER_CONTROL_INVALID_JSON"); }
      if (!value || typeof value !== "object") throw new Error("WORKER_CONTROL_INVALID_FRAME");
      const raw = value as Record<string, unknown>;
      const type = String(raw.type ?? "");
      if (!["progress", "question", "artifact", "finish"].includes(type)) throw new Error("WORKER_CONTROL_INVALID_FRAME");
      if (["progress", "finish"].includes(type) && typeof raw.summary !== "string") throw new Error("WORKER_CONTROL_INVALID_SUMMARY");
      if (type === "question" && typeof raw.question !== "string") throw new Error("WORKER_CONTROL_INVALID_QUESTION");
      if (type === "artifact" && typeof raw.path !== "string") throw new Error("WORKER_CONTROL_INVALID_ARTIFACT");
      if (type === "finish" && !["COMPLETED", "PARTIAL", "FAILED"].includes(String(raw.outcome))) throw new Error("WORKER_CONTROL_INVALID_OUTCOME");
      frames.push(raw as WorkerControlFrame);
    }
    return { frames, text: text.join("\n") };
  }

  private validateWorkerArtifacts(taskId: string, artifactIds: string[]): string[] {
    return artifactIds.map((artifactId) => {
      const artifact = this.artifacts.get({ authority: "agent-home", artifactId });
      if (artifact.ownerTaskId !== taskId) throw new Error("ARTIFACT_TASK_MISMATCH");
      return artifactId;
    });
  }

  private workerWorkspace(worker: WorkerExecutionRecord): string {
    return worker.workspaceId ? join(this.options.workerRoot, "projects", this.canonicalWorkspaceId(worker.workspaceId)) : join(this.options.workerRoot, "scratch", worker.id);
  }

  private workerSessionPath(workerId: string): string {
    return join(this.options.workerRoot, "sessions", workerId, "session.jsonl");
  }

  private async recoverySessionPath(workerId: string, storedPath: string | null): Promise<string> {
    const isolated = this.workerSessionPath(workerId);
    if (storedPath && this.pathWithinWorkerRoot(storedPath)) return storedPath;
    try { await access(isolated); return isolated; } catch { /* try the pre-isolation layout below */ }
    const legacy = join(this.options.workerRoot, "sessions", `${workerId}.jsonl`);
    try { await access(legacy); return legacy; } catch { return isolated; }
  }

  private pathWithinWorkerRoot(path: string): boolean {
    const relativePath = relative(resolve(this.options.workerRoot), resolve(path));
    return relativePath === "" || (relativePath !== ".." && !relativePath.startsWith(`..${path.includes("\\") ? "\\" : "/"}`));
  }

  private canonicalWorkspaceId(value: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value) || value === "." || value === "..") throw new Error("WORKSPACE_ID_INVALID");
    return value;
  }

  private conversationAllowed(conversations: string[], conversationId: string): boolean {
    return conversations.includes("*") || conversations.includes(conversationId);
  }

  private taskVisibleToActor(task: TaskRecord, actor: CapabilitySet): boolean {
    return actor.tasks.visibleTaskIds.includes(task.id)
      || actor.qq.sendConversations.includes(task.originConversationId)
      || actor.qq.sendConversations.includes(task.notificationConversationId);
  }

  private isTerminalTask(status: TaskStatus): boolean {
    return ["COMPLETED", "PARTIAL", "FAILED", "CANCELLED"].includes(status);
  }

  private cancellationRequested(taskId: string): boolean {
    return Boolean(this.db.get("SELECT 1 AS found FROM task_events WHERE task_id=? AND type='CANCEL_REQUESTED' LIMIT 1", taskId));
  }

  private workerCanStart(workerId: string): boolean {
    const worker = this.db.get<{ task_id: string; status: WorkerStatus }>("SELECT task_id,status FROM worker_executions WHERE id=?", workerId);
    return Boolean(worker && worker.status === "STARTING" && !this.cancellationRequested(worker.task_id));
  }

  private activeTaskCount(): number {
    return Number(this.db.get<{ count: number }>("SELECT count(*) AS count FROM tasks WHERE status IN ('CREATED','QUEUED','RUNNING','WAITING_USER','PAUSED','INTERRUPTED')")?.count ?? 0);
  }

  private activeWorkerCount(): number {
    return Number(this.db.get<{ count: number }>("SELECT count(*) AS count FROM worker_executions WHERE status IN ('PENDING','STARTING','RUNNING','WAITING_USER','STOPPING')")?.count ?? 0);
  }

  private activeProjectWorkerCount(projectId: string): number {
    return Number(this.db.get<{ count: number }>("SELECT count(*) AS count FROM worker_executions WHERE workspace_id=? AND status IN ('PENDING','STARTING','RUNNING','WAITING_USER','STOPPING')", projectId)?.count ?? 0);
  }

  private activeRequesterWorkerCount(requester: TaskRequester): number {
    const rows = this.db.all<{ requester_json: string }>("SELECT t.requester_json FROM worker_executions w JOIN tasks t ON t.id=w.task_id WHERE w.status IN ('PENDING','STARTING','RUNNING','WAITING_USER','STOPPING')");
    return rows.reduce((count, row) => {
      try {
        const current = JSON.parse(row.requester_json) as TaskRequester;
        return count + (current.platform === requester.platform && current.accountId === requester.accountId && current.userId === requester.userId ? 1 : 0);
      } catch {
        return count;
      }
    }, 0);
  }

  private limit(name: "maxTasks" | "maxWorkersTotal" | "maxWorkersPerProject" | "maxWorkersPerRequester"): number {
    const value = this.config.runtime[name];
    return Number.isInteger(value) && value > 0 ? value : Number.MAX_SAFE_INTEGER;
  }

  private audit(operation: string, decision: "ALLOW" | "DENY", reason: string | undefined, resource: string, requesterId?: string, taskId?: string): void {
    this.db.run("INSERT INTO authorization_audit_events(id,operation,decision,reason,resource,requester_id,task_id,metadata_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)", newId("authz"), operation, decision, reason ?? null, resource, requesterId ?? null, taskId ?? null, null, nowIso());
  }

  private canonicalCapabilities(input: { requester: TaskRequester; trust: "OWNER" | "GUEST"; originConversationId: string }): CapabilitySet | undefined {
    if (!this.config.owner) return undefined;
    const row = this.db.get<{ platform: string; account_id: string; kind: "private" | "group"; platform_conversation_id: string; thread_id_json: string }>("SELECT platform,account_id,kind,platform_conversation_id,thread_id_json FROM conversations WHERE conversation_id=?", input.originConversationId);
    if (!row) return undefined;
    return deriveCapabilities({ ...input.requester, trust: input.trust, conversationId: input.originConversationId }, { platform: row.platform, accountId: row.account_id, kind: row.kind, platformConversationId: row.platform_conversation_id, threadId: JSON.parse(row.thread_id_json) }, this.config.owner, input.originConversationId);
  }
}
