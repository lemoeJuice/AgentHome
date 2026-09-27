import { access, chmod, chown, mkdir, open, readFile, readdir, realpath, stat } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { configuredOwners, type AppConfig } from "../config.js";
import type { SqliteStore } from "../db.js";
import { attenuateTask, attenuateWorker, capabilityWithin, deriveCapabilities, validateCapabilitySet, type AuthorizationDecision, authorizeSend } from "../auth.js";
import { newId, nowIso, messageKey } from "../shared/ids.js";
import type { ArtifactRef, CapabilitySet, JsonValue, PlatformMessageRef, TaskRecord, TaskRequester, TaskStatus, WorkerExecutionRecord, WorkerStatus } from "../shared/types.js";
import type { ArtifactService } from "./artifacts.js";
import { piNetworkFailureHint, type PiHarness, type PiImageContent, type PiProcessIdentity, type PiSandbox, type PiSession } from "./pi.js";
import type { GatewayMcpClient } from "./mcp.js";
import type { Logger } from "../shared/logger.js";
import { canonicalWorkspaceId, OWNER_RUNTIME_UID, type PrincipalService } from "./principals.js";
import { type ExecutionBackend, type ExecutionContext, type ExecutionRequest } from "./execution.js";
import { MODEL_RUNTIME_GID, MODEL_RUNTIME_UID } from "./model-plane.js";
import { PI_IMAGE_INPUT_MAX_BYTES, piImageContent, sniffImageMimeType } from "./images.js";
import { proxyEnvironment } from "./network.js";

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
  principals?: PrincipalService;
  guestExecCommand?: string;
  modelSessionsRoot?: string;
  modelRuntimeUid?: number;
  modelRuntimeGid?: number;
  createWorkerToolContext?: (worker: WorkerExecutionRecord, task: TaskRecord) => { token: string; socketPath: string };
}

export class TaskService implements ExecutionBackend {
  private readonly db: SqliteStore;
  private readonly pi: PiHarness;
  private readonly artifacts: ArtifactService;
  private readonly config: AppConfig;
  private readonly options: TaskServiceOptions;
  private readonly activeSessions = new Map<string, PiSession>();
  private readonly activePrincipalCommands = new Map<string, Set<ChildProcess>>();
  private readonly projectUsageChecks = new Map<string, NodeJS.Timeout>();
  private readonly log: Logger;

  constructor(db: SqliteStore, pi: PiHarness, artifacts: ArtifactService, config: AppConfig, options: TaskServiceOptions, logger: Logger) {
    this.db = db; this.pi = pi; this.artifacts = artifacts; this.config = config; this.options = options;
    this.log = logger.child("tasks");
  }

  createTask(input: { title: string; goal: string; requester: TaskRequester; trust: "OWNER" | "GUEST"; originConversationId: string; notificationConversationId: string; parentTaskId?: string; parentCapabilities: CapabilitySet; requestedCapabilities?: Partial<CapabilitySet> }): TaskRecord {
    const mapped = input.requester.principalId ? undefined : this.db.get<{ principal_id: string }>("SELECT principal_id FROM platform_identities WHERE platform=? AND account_id=? AND user_id=?", input.requester.platform, input.requester.accountId, input.requester.userId);
    const principalId = input.requester.principalId ?? mapped?.principal_id;
    const principal = principalId ? this.options.principals?.get(principalId) : undefined;
    const requester: TaskRequester = { ...input.requester, ...(principalId ? { principalId } : {}), ...(principal ? { runtimeUid: principal.runtimeUid, runtimeGid: principal.runtimeGid } : {}) };
    const parentCapabilities = validateCapabilitySet(input.parentCapabilities);
    if (!parentCapabilities.tasks.canCreate) { this.audit("task.create", "DENY", "TASK_CREATE_DENIED", input.originConversationId, input.requester.userId); throw new Error("TASK_CREATE_DENIED"); }
    if (!this.conversationAllowed(parentCapabilities.qq.sendConversations, input.notificationConversationId)) { this.audit("task.create", "DENY", "TASK_NOTIFICATION_DENIED", input.notificationConversationId, input.requester.userId); throw new Error("TASK_NOTIFICATION_DENIED"); }
    if (this.activeTaskCount() >= this.limit("maxTasks")) throw new Error("TASK_QUOTA_EXCEEDED");
    if (this.activeRequesterTaskCount(requester) >= this.limit("maxTasksPerRequester")) throw new Error("TASK_REQUESTER_QUOTA_EXCEEDED");
    if (requester.principalId && this.activePrincipalTaskCount(requester.principalId) >= this.limit("maxTasksPerPrincipal")) throw new Error("TASK_PRINCIPAL_QUOTA_EXCEEDED");
    if (input.parentTaskId) {
      const parentTask = this.getTask(input.parentTaskId);
      if (!this.taskVisibleToActor(parentTask, parentCapabilities, requester.principalId, requester)) { this.audit("task.create", "DENY", "TASK_PARENT_DENIED", input.parentTaskId, requester.userId); throw new Error("TASK_PARENT_DENIED"); }
    }
    const canonical = this.canonicalCapabilities({ ...input, requester });
    if (canonical && !capabilityWithin(parentCapabilities, canonical)) throw new Error("CAPABILITY_CONTEXT_INVALID");
    const id = newId("task");
    let capabilities: CapabilitySet;
    try { capabilities = attenuateTask(parentCapabilities, input.requestedCapabilities ?? {}, id); }
    catch (error) { this.audit("task.create", "DENY", error instanceof Error ? error.message : String(error), id, input.requester.userId); throw error; }
    const timestamp = nowIso();
    const deadlineAt = input.trust === "GUEST" ? new Date(Date.now() + (this.config.guest?.taskTimeoutMs ?? 30 * 60 * 1000)).toISOString() : undefined;
    const task: TaskRecord = { id, title: input.title, goal: input.goal, status: "CREATED", requester, trust: input.trust, originConversationId: input.originConversationId, notificationConversationId: input.notificationConversationId, ...(input.parentTaskId ? { parentTaskId: input.parentTaskId } : {}), capabilities, createdAt: timestamp, updatedAt: timestamp, ...(deadlineAt ? { deadlineAt } : {}) };
    this.db.transaction(() => {
      this.db.run("INSERT INTO tasks(id,title,goal,status,requester_json,trust,origin_conversation_id,notification_conversation_id,parent_task_id,capabilities_json,created_at,updated_at,principal_id,deadline_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", id, task.title, task.goal, task.status, JSON.stringify(task.requester), task.trust, task.originConversationId, task.notificationConversationId, task.parentTaskId ?? null, JSON.stringify(task.capabilities), timestamp, timestamp, requester.principalId ?? null, deadlineAt ?? null);
      this.event(id, "TASK_CREATED", undefined, { title: task.title });
    });
    this.log.debug("Task Principal capabilities persisted", { taskId: id, principalId: requester.principalId, role: input.trust, uid: requester.runtimeUid, gid: requester.runtimeGid, capabilities: { projects: capabilities.projects }, executionProfile: "TASK_CAPABILITY_SNAPSHOT", scope: input.originConversationId, contextSource: requester.principalId ? "resolved-principal" : "unbound-requester" });
    this.audit("task.create", "ALLOW", undefined, id, input.requester.userId, id);
    return task;
  }

  async createWorker(input: { taskId: string; objective: string; workspaceId?: string; workspaceAccess?: "READ" | "WRITE"; requestedCapabilities?: Partial<CapabilitySet>; artifactRefs?: ArtifactRef[]; sourceMailboxId?: string; actor: CapabilitySet; actorPrincipalId?: string; actorRequester?: TaskRequester }): Promise<WorkerExecutionRecord> {
    const task = this.getTask(input.taskId);
    if (this.isTerminalTask(task.status) || this.cancellationRequested(task.id)) throw new Error("TASK_CREATE_WORKER_DENIED");
    const isGuest = task.trust === "GUEST" && Boolean(this.options.principals);
    if (isGuest && !this.config.guest.enabled) throw new Error("GUEST_TASK_EXECUTION_DISABLED");
    const effectivePrincipalId = task.requester.principalId ?? input.actorPrincipalId ?? input.actorRequester?.principalId;
    const principal = effectivePrincipalId ? this.options.principals?.get(effectivePrincipalId) : undefined;
    if (this.options.principals && !principal) throw new Error("WORKER_PRINCIPAL_REQUIRED");
    const principalExecution = Boolean(principal);
    const workspaceId = input.workspaceId ? canonicalWorkspaceId(input.workspaceId) : principalExecution ? "default" : undefined;
    const inheritedWorkspaceRights = workspaceId ? task.capabilities.projects.filter((project) => project.projectId === "*" || project.projectId === workspaceId) : [];
    const inheritedWorkspaceAccess = inheritedWorkspaceRights.some((project) => project.access === "WRITE") ? "WRITE" : inheritedWorkspaceRights.length ? "READ" : undefined;
    const workspaceAccess = input.workspaceAccess ?? (principalExecution ? inheritedWorkspaceAccess : undefined);
    const actor = validateCapabilitySet(input.actor);
    const actorPrincipalId = input.actorPrincipalId ?? input.actorRequester?.principalId;
    if (!actor.tasks.canCreate || !this.taskVisibleToActor(task, actor, actorPrincipalId, input.actorRequester)) throw new Error("TASK_CREATE_WORKER_DENIED");
    if (principalExecution && workspaceId && !workspaceAccess) throw new Error("PROJECT_ACCESS_DENIED");
    if (workspaceId && workspaceAccess && !task.capabilities.projects.some((project) => (project.projectId === "*" || project.projectId === workspaceId) && (project.access === "WRITE" || project.access === workspaceAccess))) throw new Error("PROJECT_ACCESS_DENIED");
    if (isGuest && !principal) throw new Error("GUEST_PRINCIPAL_REQUIRED");
    if (principal && this.options.principals) {
      await this.options.principals.ensurePrincipalDirectories(principal.principalId);
      if (workspaceId) await this.options.principals.workspacePath(principal.principalId, workspaceId);
    }
    const workspaceScopeId = workspaceId ? this.workspaceScopeId(task, workspaceId) : undefined;
    const workerCount = Number(this.db.get<{ count: number }>("SELECT count(*) AS count FROM worker_executions WHERE task_id=? AND status IN ('PENDING','STARTING','RUNNING','WAITING_USER','STOPPING')", input.taskId)?.count ?? 0);
    if (workerCount >= this.config.runtime.maxWorkers) throw new Error("WORKER_QUOTA_EXCEEDED");
    if (this.activeWorkerCount() >= this.limit("maxWorkersTotal")) throw new Error("WORKER_TOTAL_QUOTA_EXCEEDED");
    if (workspaceScopeId && this.activeProjectWorkerCount(workspaceScopeId) >= this.limit("maxWorkersPerProject")) throw new Error("WORKER_PROJECT_QUOTA_EXCEEDED");
    if (this.activeRequesterWorkerCount(task.requester) >= this.limit("maxWorkersPerRequester")) throw new Error("WORKER_REQUESTER_QUOTA_EXCEEDED");
    if (isGuest && task.requester.principalId && this.activeRequesterWorkerCount(task.requester) >= this.config.guest.maxWorkersPerPrincipal) throw new Error("GUEST_WORKER_PRINCIPAL_QUOTA_EXCEEDED");
    const workerId = newId("worker");
    const requestedCapabilities = input.requestedCapabilities ?? defaultWorkerCapabilityRequest(task, workspaceId, workspaceAccess);
    let capabilities: CapabilitySet;
    try { capabilities = attenuateWorker(task.capabilities, requestedCapabilities); }
    catch (error) { this.audit("worker.create", "DENY", error instanceof Error ? error.message : String(error), task.id, task.requester.userId, task.id); throw error; }
    for (const ref of input.artifactRefs ?? []) this.artifacts.bindToTask(ref, { taskId: task.id, conversationId: task.originConversationId, requesterId: task.requester.userId });
    const lockRequired = workspaceAccess === "WRITE" && Boolean(workspaceScopeId);
    const lockAcquired = lockRequired && this.tryAcquireLock(workspaceScopeId as string, workerId);
    const status: WorkerStatus = lockRequired && !lockAcquired ? "PENDING" : "STARTING";
    const timestamp = nowIso();
    const worker: WorkerExecutionRecord = { id: workerId, taskId: input.taskId, objective: input.objective, status, harness: "pi", processMode: principalExecution ? "PRINCIPAL_BROKERED" : "PI", ...(effectivePrincipalId ? { principalId: effectivePrincipalId } : {}), ...(principal ? { runtimeUid: principal.runtimeUid, runtimeGid: principal.runtimeGid } : {}), ...(workspaceId ? { workspaceId } : {}), ...(workspaceScopeId ? { workspaceScopeId } : {}), ...(workspaceAccess ? { workspaceAccess } : {}), ...(input.artifactRefs?.length ? { artifactRefs: input.artifactRefs } : {}), updatedAt: timestamp };
    worker.capabilities = capabilities;
    const executionProfile = describeExecutionProfile(worker);
    this.log.debug("Worker execution profile selected", { taskId: task.id, workerId, principalId: effectivePrincipalId, role: principal?.role ?? task.trust, uid: principal?.runtimeUid ?? worker.runtimeUid, gid: principal?.runtimeGid ?? worker.runtimeGid, workspaceId, workspace: workspaceId && principal ? this.options.principals?.workspacePathSync(principal.principalId, workspaceId) : workspaceId ? join(this.options.workerRoot, "projects", workspaceId) : undefined, workspaceAccess, capabilities: { projects: capabilities.projects }, executionProfile, scope: workspaceScopeId ?? workspaceId, contextSource: principalExecution ? "durable-task-and-worker-records" : "legacy-worker-record" });
    if (workspaceAccess === "READ") this.log.warn("Read-only Worker profile persisted", { taskId: task.id, workerId, principalId: effectivePrincipalId, role: principal?.role ?? task.trust, uid: principal?.runtimeUid ?? worker.runtimeUid, gid: principal?.runtimeGid ?? worker.runtimeGid, workspaceId, workspace: workspaceId && principal ? this.options.principals?.workspacePathSync(principal.principalId, workspaceId) : undefined, capabilities: { projects: capabilities.projects }, executionProfile, scope: workspaceScopeId ?? workspaceId, contextSource: principalExecution ? "durable-task-and-worker-records" : "legacy-worker-record" });
    try {
      this.db.transaction(() => {
        this.db.run("INSERT INTO worker_executions(id,task_id,objective,status,harness,workspace_id,workspace_access,capabilities_json,artifact_refs_json,mcp_binding_token,updated_at,principal_id,runtime_uid,runtime_gid,workspace_scope_id,process_mode,source_mailbox_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", workerId, input.taskId, input.objective, status, "pi", workspaceId ?? null, workspaceAccess ?? null, JSON.stringify(capabilities), input.artifactRefs?.length ? JSON.stringify(input.artifactRefs) : null, null, timestamp, effectivePrincipalId ?? null, principal?.runtimeUid ?? null, principal?.runtimeGid ?? null, workspaceScopeId ?? null, worker.processMode ?? "PI", input.sourceMailboxId ?? null);
        this.event(input.taskId, "WORKER_CREATED", workerId, { status });
        this.db.run("UPDATE tasks SET status=?,updated_at=? WHERE id=? AND status IN ('CREATED','QUEUED')", status === "PENDING" ? "QUEUED" : "RUNNING", timestamp, input.taskId);
      });
    } catch (error) {
      if (lockAcquired && workspaceScopeId) this.db.run("DELETE FROM project_locks WHERE project_id=? AND owner_worker_id=?", workspaceScopeId, workerId);
      throw error;
    }
    this.audit("worker.create", "ALLOW", undefined, workerId, task.requester.userId, task.id);
    try { await this.ensureWorkerBinding(workerId); }
    catch (error) { await this.failWorker(workerId, String(error)); throw error; }
    if (status === "STARTING") void this.startWorker(workerId).catch((error) => this.log.error("Worker startup failed", { workerId, error: String(error) }));
    return worker;
  }

  async executionContext(workerId: string): Promise<ExecutionContext> {
    const worker = this.getWorker(workerId);
    const task = this.getTask(worker.taskId);
    if (!worker.principalId || !task.requester.principalId || worker.principalId !== task.requester.principalId || !this.options.principals) throw new Error("WORKER_PRINCIPAL_REQUIRED");
    if (worker.processMode !== "PRINCIPAL_BROKERED" && worker.processMode !== "GUEST_BROKERED") throw new Error("WORKER_EXECUTION_BACKEND_REQUIRED");
    const principal = this.options.principals.get(worker.principalId);
    if (principal.role !== task.trust) throw new Error("WORKER_PRINCIPAL_ROLE_MISMATCH");
    if (worker.runtimeUid !== principal.runtimeUid || worker.runtimeGid !== principal.runtimeGid || !worker.workspaceId || !worker.workspaceAccess) throw new Error("WORKER_PRINCIPAL_IDENTITY_MISMATCH");
    if (task.trust === "GUEST" && !this.config.guest.enabled) throw new Error("GUEST_PROCESS_EXEC_DENIED");
    const dirs = await this.options.principals.ensurePrincipalDirectories(principal.principalId);
    const workspace = await this.options.principals.workspacePath(principal.principalId, worker.workspaceId);
    const capabilities = worker.capabilities;
    if (!capabilities) throw new Error("WORKER_CAPABILITY_SNAPSHOT_MISSING");
    const workspaceCapability = capabilities.projects.find((project) => project.projectId === "*" || project.projectId === worker.workspaceId);
    if (!workspaceCapability) throw new Error("WORKSPACE_CAPABILITY_MISSING");
    if (worker.workspaceAccess === "WRITE" && workspaceCapability.access !== "WRITE") throw new Error("WORKSPACE_WRITE_CAPABILITY_MISSING");
    const context: ExecutionContext = { executionContextId: `${task.id}:${worker.id}:${principal.principalId}`, taskId: task.id, workerId: worker.id, principalId: principal.principalId, workspaceId: worker.workspaceId, ...(worker.workspaceScopeId ? { workspaceScopeId: worker.workspaceScopeId } : {}), uid: principal.runtimeUid, gid: principal.runtimeGid, role: principal.role, capabilities, workspace, workspaceAccess: worker.workspaceAccess, executionProfile: describeExecutionProfile(worker), contextSource: "durable-worker-record", home: dirs.home, ...(worker.harnessSessionId ? { sessionId: worker.harnessSessionId } : {}) };
    this.log.debug("Worker ExecutionContext reconstructed", executionContextLogFields(context));
    return context;
  }

  async execute(context: ExecutionContext, input: ExecutionRequest): Promise<JsonValue> {
    return this.executeAsPrincipal(context, input, true);
  }

  async readFile(context: ExecutionContext, path: string): Promise<unknown> { return this.executeFileOperation(context, { operation: "read", path }); }
  async writeFile(context: ExecutionContext, path: string, content: string): Promise<unknown> { return this.executeFileOperation(context, { operation: "write", path, content }); }
  async editFile(context: ExecutionContext, path: string, oldText: string, newText: string): Promise<unknown> { return this.executeFileOperation(context, { operation: "edit", path, oldText, newText }); }
  async makeDirectory(context: ExecutionContext, path: string): Promise<unknown> { return this.executeFileOperation(context, { operation: "mkdir", path }); }
  async removePath(context: ExecutionContext, path: string): Promise<unknown> { return this.executeFileOperation(context, { operation: "remove", path }); }
  async listDirectory(context: ExecutionContext, path = ""): Promise<unknown> { return this.executeFileOperation(context, { operation: "list", path }); }
  async statPath(context: ExecutionContext, path: string): Promise<unknown> { return this.executeFileOperation(context, { operation: "stat", path }); }

  private async executeFileOperation(context: ExecutionContext, request: { operation: "read" | "write" | "edit" | "mkdir" | "remove" | "list" | "stat"; path: string; content?: string; oldText?: string; newText?: string }): Promise<unknown> {
    if (typeof request.path !== "string" || request.path.length > 4096 || (request.content?.length ?? 0) > 512 * 1024 || (request.oldText?.length ?? 0) > 512 * 1024 || (request.newText?.length ?? 0) > 512 * 1024) throw new Error("WORKSPACE_TOOL_INPUT_INVALID");
    const mutating = ["write", "edit", "mkdir", "remove"].includes(request.operation);
    if (context.workspaceAccess !== "WRITE" && mutating) {
      this.log.warn("Worker write denied by read-only execution profile", { ...executionContextLogFields(context), operation: request.operation, contextSource: "durable-worker-record" });
      throw new Error("WORKER_PROFILE_READ_ONLY");
    }
    const command = `node -e ${shellQuote(PRINCIPAL_FILE_TOOL_SCRIPT)} ${shellQuote(JSON.stringify(request))}`;
    const result = await this.executeAsPrincipal(context, { command }, mutating, true);
    if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("WORKSPACE_TOOL_RESPONSE_INVALID");
    const commandResult = result as Record<string, JsonValue>;
    if (commandResult.exitCode !== 0) throw new Error(classifyWorkspaceExecutionFailure(String(commandResult.stderr ?? "")));
    let envelope: { ok?: boolean; result?: unknown; errorCode?: string };
    try { envelope = JSON.parse(String(commandResult.stdout ?? "")) as typeof envelope; }
    catch { throw new Error("WORKSPACE_TOOL_RESPONSE_INVALID"); }
    if (envelope.ok !== true) {
      const errorCode = typeof envelope.errorCode === "string" && envelope.errorCode.startsWith("WORKSPACE_")
        ? envelope.errorCode
        : classifyWorkspaceErrorCode(String(envelope.errorCode ?? ""));
      throw new Error(errorCode);
    }
    return envelope.result;
  }

  private async executeAsPrincipal(context: ExecutionContext, input: ExecutionRequest, requireWrite: boolean, runtimeGeneratedCommand = false): Promise<JsonValue> {
    const current = await this.executionContext(context.workerId);
    if (context.executionContextId !== current.executionContextId || context.taskId !== current.taskId || context.workerId !== current.workerId || context.principalId !== current.principalId || context.workspaceId !== current.workspaceId || context.workspaceScopeId !== current.workspaceScopeId || context.uid !== current.uid || context.gid !== current.gid || context.role !== current.role || context.workspace !== current.workspace || context.home !== current.home || context.workspaceAccess !== current.workspaceAccess || context.executionProfile !== current.executionProfile || JSON.stringify(context.capabilities) !== JSON.stringify(current.capabilities)) throw new Error("EXECUTION_CONTEXT_STALE_OR_FORGED");
    if (requireWrite && current.workspaceAccess !== "WRITE") {
      this.log.warn("Worker process execution denied by read-only execution profile", { ...executionContextLogFields(current), contextSource: "durable-worker-record" });
      throw new Error("WORKER_PROFILE_READ_ONLY");
    }
    const worker = this.getWorker(current.workerId);
    const task = this.getTask(current.taskId);
    const guest = task.trust === "GUEST";
    if (!["STARTING", "RUNNING", "WAITING_USER"].includes(worker.status) || this.cancellationRequested(task.id)) throw new Error("WORKER_NOT_RUNNING");
    if (typeof input.command !== "string" || !input.command.trim() || input.command.length > (runtimeGeneratedCommand ? 600_000 : 32_768)) throw new Error("WORKER_COMMAND_INVALID");
    const remainingTaskMs = guest ? this.remainingGuestTaskMs(task) : Number.POSITIVE_INFINITY;
    const principalDirs = await this.options.principals!.ensurePrincipalDirectories(current.principalId);
    const root = await realpath(current.workspace);
    const cwd = await this.resolveGuestWorkingDirectory(root, input.cwd);
    if (guest) await this.assertGuestQuota(principalDirs, root);
    const commandTimeout = guest ? this.config.guest.commandTimeoutMs : this.config.runtime.piTimeoutMs;
    const timeoutMs = Math.max(1, Math.min(Number.isSafeInteger(input.timeoutMs) ? Number(input.timeoutMs) : commandTimeout, commandTimeout, remainingTaskMs));
    const helper = this.options.guestExecCommand ?? "/usr/local/bin/agent-home-guest-exec";
    const environment = this.options.principals!.principalProcessEnvironment(current.principalId, this.config.network?.modelProxyUrl);
    const child = spawn(helper, [String(current.uid), String(current.gid), String(this.config.guest.cpuSeconds), String(this.config.guest.memoryBytes), String(this.config.guest.pids), String(this.config.guest.maxFileBytes), "--", "/bin/bash", "-c", input.command], { cwd, env: environment, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const active = this.activePrincipalCommands.get(worker.id) ?? new Set<ChildProcess>();
    active.add(child);
    this.activePrincipalCommands.set(worker.id, active);
    let processRecordId: string | undefined;
    let processId: number | undefined;
    let processGroupId: number | undefined;
    let processStartTime: string | undefined;
    let processClean = false;
    try {
      await new Promise<void>((resolvePromise, reject) => { child.once("spawn", () => resolvePromise()); child.once("error", reject); });
      if (!["STARTING", "RUNNING", "WAITING_USER"].includes(this.getWorker(worker.id).status) || this.cancellationRequested(task.id)) throw new Error("WORKER_NOT_RUNNING");
      processId = child.pid;
      const processIdentity = processId ? await this.readProcessIdentity(processId) : undefined;
      if (!processId || !processIdentity) throw new Error("GUEST_PROCESS_IDENTITY_UNAVAILABLE");
      processGroupId = processIdentity.processGroupId;
      processStartTime = processIdentity.startTime;
      processRecordId = newId("principal-process");
      this.db.run("INSERT INTO owned_processes(id,task_id,worker_id,pid,process_group_id,command_summary,started_at,pid_start_time,process_kind) VALUES (?,?,?,?,?,?,?,?,?)", processRecordId, task.id, worker.id, processId, processGroupId, "principal workspace command", nowIso(), processStartTime, "PRINCIPAL_EXEC");
    } catch (error) {
      if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* already gone */ } } }
      active.delete(child);
      if (active.size === 0) this.activePrincipalCommands.delete(worker.id);
      throw error;
    }
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let quotaError: string | undefined;
    let quotaCheck = Promise.resolve();
    let settled = false;
    const killGroup = (signal: NodeJS.Signals): void => {
      if (!child.pid) return;
      try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch { /* already exited */ } }
      if (signal === "SIGTERM") setTimeout(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* process group exited */ } }, 1500).unref();
    };
    const timer = setTimeout(() => { quotaError = "PRINCIPAL_COMMAND_TIMEOUT"; killGroup("SIGTERM"); }, timeoutMs);
    const quotaTimer = guest ? setInterval(() => {
      quotaCheck = quotaCheck.then(async () => {
        if (!settled && await this.guestQuotaExceeded(principalDirs, root)) {
          quotaError = "GUEST_WORKSPACE_QUOTA_EXCEEDED";
          killGroup("SIGTERM");
        }
      }).catch((error) => { quotaError = `GUEST_QUOTA_CHECK_FAILED:${String(error).slice(0, 100)}`; killGroup("SIGTERM"); });
    }, 2000).unref() : undefined;
    const append = (current: string, chunk: Buffer): string => {
      outputBytes += chunk.byteLength;
      if (outputBytes > 1_048_576) {
        quotaError = "PRINCIPAL_COMMAND_OUTPUT_LIMIT";
        killGroup("SIGTERM");
      }
      return `${current}${chunk.toString("utf8")}`.slice(0, 1_048_576);
    };
    child.stdout?.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
    try {
      const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolvePromise, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => resolvePromise({ code, signal }));
      });
      processClean = await this.terminatePrincipalCommand(worker.id, child);
      if (!processClean) quotaError ??= "PRINCIPAL_PROCESS_GROUP_CLEANUP_FAILED";
      await quotaCheck;
      return { exitCode: result.code, signal: result.signal, stdout, stderr, ...(quotaError ? { error: quotaError } : {}) };
    } finally {
      settled = true;
      clearTimeout(timer);
      if (quotaTimer) clearInterval(quotaTimer);
      active.delete(child);
      if (active.size === 0) this.activePrincipalCommands.delete(worker.id);
      if (processRecordId && processClean) this.db.run("DELETE FROM owned_processes WHERE id=?", processRecordId);
    }
  }

  async executeWorkerCommand(workerId: string, input: ExecutionRequest, executionContextId?: string): Promise<JsonValue> {
    const context = await this.executionContext(workerId);
    if (executionContextId && executionContextId !== context.executionContextId) throw new Error("EXECUTION_CONTEXT_STALE_OR_FORGED");
    return this.execute(context, input);
  }

  async prepareGuestToolContext(worker: WorkerExecutionRecord, task: TaskRecord): Promise<{ token: string; socketPath: string }> {
    const context = this.options.createWorkerToolContext?.(worker, task);
    if (!context) throw new Error("WORKER_TOOL_CONTEXT_UNAVAILABLE");
    return context;
  }

  private async resolveGuestWorkingDirectory(workspaceRoot: string, cwd?: string): Promise<string> {
    if (!cwd) return workspaceRoot;
    if (resolve(cwd) === cwd || cwd.startsWith("/") || cwd.split(/[\\/]/).includes("..")) throw new Error("GUEST_CWD_OUTSIDE_WORKSPACE");
    const candidate = resolve(workspaceRoot, cwd);
    if (!pathWithin(workspaceRoot, candidate)) throw new Error("GUEST_CWD_OUTSIDE_WORKSPACE");
    await mkdir(candidate, { recursive: true, mode: 0o700 });
    const real = await realpath(candidate);
    if (!pathWithin(workspaceRoot, real)) throw new Error("GUEST_CWD_OUTSIDE_WORKSPACE");
    return real;
  }

  private async assertGuestQuota(principalDirs: { root: string; home: string; projects: string; cache: string; agent: string; artifacts: string }, workspace: string): Promise<void> {
    const exceeded = await this.guestQuotaExceeded(principalDirs, workspace);
    if (exceeded) throw new Error("GUEST_WORKSPACE_QUOTA_EXCEEDED");
  }

  private async guestQuotaExceeded(principalDirs: { root: string; home: string; projects: string; cache: string; agent: string; artifacts: string }, workspace: string): Promise<boolean> {
    let workspaceBytes = 0;
    for (const directory of [principalDirs.home, principalDirs.projects, principalDirs.agent, principalDirs.artifacts]) {
      workspaceBytes += await directoryBytes(directory, this.config.guest.workspaceQuotaBytes - workspaceBytes);
      if (workspaceBytes > this.config.guest.workspaceQuotaBytes) return true;
    }
    return (await directoryBytes(principalDirs.cache, this.config.guest.cacheQuotaBytes)) > this.config.guest.cacheQuotaBytes;
  }

  private workspaceScopeId(task: TaskRecord, workspaceId: string): string {
    return task.requester.principalId ? `principal:${task.requester.principalId}:${workspaceId}` : workspaceId;
  }

  private async readProcessIdentity(pid: number): Promise<{ processGroupId: number; startTime: string } | undefined> {
    try {
      const line = await readFile(`/proc/${pid}/stat`, "utf8");
      const close = line.lastIndexOf(")");
      const fields = line.slice(close + 2).trim().split(/\s+/);
      const processGroupId = Number(fields[2]);
      const startTime = fields[19];
      return Number.isInteger(processGroupId) && startTime ? { processGroupId, startTime } : undefined;
    } catch { return undefined; }
  }

  async startWorker(workerId: string): Promise<void> {
    let worker = this.getWorker(workerId);
    if (worker.status !== "STARTING" && worker.status !== "PENDING") return;
    if (worker.status === "PENDING" && worker.workspaceAccess === "WRITE" && worker.workspaceId && !this.hasLock(worker.workspaceScopeId ?? worker.workspaceId, worker.id) && !this.tryAcquireLock(worker.workspaceScopeId ?? worker.workspaceId, worker.id)) return;
    if (worker.status === "PENDING") {
      const claimed = this.db.run("UPDATE worker_executions SET status='STARTING',updated_at=? WHERE id=? AND status='PENDING'", nowIso(), worker.id).changes > 0;
      if (!claimed) return;
      worker = this.getWorker(workerId);
    }
    if (!this.workerCanStart(worker.id)) return;
    const task = this.getTask(worker.taskId);
    if (this.options.principals && !worker.principalId) { await this.failWorker(worker.id, "WORKER_PRINCIPAL_REQUIRED"); return; }
    const principalBrokered = isPrincipalBrokered(worker.processMode);
    if (task.trust === "GUEST" && this.remainingGuestTaskMs(task) <= 0) { await this.failWorker(worker.id, "GUEST_TASK_TIMEOUT"); return; }
    const modelUid = this.options.modelRuntimeUid ?? MODEL_RUNTIME_UID;
    const modelGid = this.options.modelRuntimeGid ?? MODEL_RUNTIME_GID;
    const sessionPath = this.workerSessionPath(worker.id);
    let projectPath: string;
    let workerToolContext: { token: string; socketPath: string } | undefined;
    try {
      projectPath = this.workerWorkspace(worker);
      if (principalBrokered) {
        if (!worker.principalId || !this.options.principals || worker.runtimeUid === undefined || worker.runtimeGid === undefined) throw new Error("WORKER_PRINCIPAL_FILESYSTEM_REQUIRED");
        if (process.getuid?.() !== 0) throw new Error("PRINCIPAL_EXECUTION_REQUIRES_SYSTEM_ROOT");
        await this.options.principals.ensurePrincipalDirectories(worker.principalId);
        projectPath = await this.options.principals.workspacePath(worker.principalId, worker.workspaceId ?? "default");
        await this.ensureSystemPrivateDirectory(dirname(sessionPath), modelUid, modelGid);
        workerToolContext = await this.prepareGuestToolContext(worker, task);
      } else {
        await this.ensureSystemPrivateDirectory(dirname(sessionPath));
        await mkdir(projectPath, { recursive: true, mode: 0o700 });
      }
    } catch (error) {
      await this.failWorker(worker.id, String(error));
      throw error;
    }
    this.log.debug("Worker Pi harness started", { taskId: task.id, workerId: worker.id, principalId: worker.principalId, role: task.trust, uid: worker.runtimeUid, gid: worker.runtimeGid, workspace: projectPath, workspaceId: worker.workspaceId, workspaceAccess: worker.workspaceAccess, capabilities: { projects: worker.capabilities?.projects ?? [] }, executionProfile: describeExecutionProfile(worker), scope: worker.workspaceScopeId ?? worker.workspaceId, artifactRefCount: worker.artifactRefs?.length ?? 0, contextSource: "durable-worker-records", piCwd: principalBrokered ? dirname(sessionPath) : projectPath, sessionRoot: dirname(sessionPath) });
    let mcpToken: string | undefined;
    try { mcpToken = await this.ensureWorkerBinding(worker.id); }
    catch (error) { await this.failWorker(worker.id, String(error)); return; }
    if (!this.workerCanStart(worker.id)) return;
    const sandbox: PiSandbox = { sessionRoot: dirname(sessionPath), ...(principalBrokered ? { launcherUid: modelUid, launcherGid: modelGid } : {}), ...(workerToolContext ? { toolSocket: workerToolContext.socketPath, toolToken: workerToolContext.token } : {}) };
    const piCwd = principalBrokered ? dirname(sessionPath) : projectPath;
    const inboundFiles: string[] = [];
    const imageInputs: PiImageContent[] = [];
    let session: PiSession;
    try {
      for (const ref of worker.artifactRefs ?? []) {
        const materialized = await this.artifacts.materializeForRead(ref, { conversationId: task.originConversationId, requesterId: task.requester.userId, taskId: task.id, readCapability: worker.capabilities?.artifacts ?? { readableArtifactAuthorities: [] } }, projectPath);
        const visual = await readArtifactImage(materialized.path, materialized.metadata);
        if (visual.imageInput) imageInputs.push(visual.imageInput);
        else if (visual.reason) {
          this.log.warn("Worker image Artifact was not injected into Pi visual input", { taskId: task.id, workerId: worker.id, artifactId: ref.artifactId, size: materialized.metadata.size, mime: materialized.metadata.mime, filename: materialized.metadata.filename, reason: visual.reason, principalId: worker.principalId, workspace: projectPath, executionProfile: describeExecutionProfile(worker), scope: worker.workspaceScopeId ?? worker.workspaceId, contextSource: "authorized-worker-artifact" });
        }
        if (principalBrokered && worker.runtimeUid !== undefined && worker.runtimeGid !== undefined) {
          await chown(dirname(materialized.path), worker.runtimeUid, worker.runtimeGid);
          await chmod(dirname(materialized.path), 0o700);
          await chown(materialized.path, worker.runtimeUid, worker.runtimeGid);
          await chmod(materialized.path, 0o600);
        }
        inboundFiles.push(`${materialized.metadata.filename} (${materialized.metadata.mime ?? "application/octet-stream"}, ${materialized.metadata.size} bytes), available at sandbox-relative path ${relative(projectPath, materialized.path)}`);
      }
      const useWorkerExtension = Boolean(this.options.workerToolExtensionPath && (mcpToken || principalBrokered));
      session = await this.pi.createSession(sessionPath, { cwd: piCwd, sandbox, ...(useWorkerExtension ? { extensionPath: this.options.workerToolExtensionPath } : {}), ...(principalBrokered ? { mainTools: true } : {}) });
      if (!this.workerCanStart(worker.id)) { await this.pi.abort(session); return; }
      this.activeSessions.set(worker.id, session);
      const processIdentity = await this.pi.processInfo?.(session);
      const processId = processIdentity?.pid ?? this.pi.processId?.(session);
      const startedAt = nowIso();
      const started = this.db.transaction(() => {
        const update = this.db.run("UPDATE worker_executions SET status='RUNNING',harness_session_id=?,harness_session_path=?,process_id=?,started_at=?,updated_at=? WHERE id=? AND status='STARTING'", session.sessionId, session.sessionPath, processId ?? null, startedAt, startedAt, worker.id);
        if (update.changes === 0) return false;
        this.db.run("DELETE FROM owned_processes WHERE worker_id=? AND process_kind='PI'", worker.id);
        if (processId) this.db.run("INSERT INTO owned_processes(id,task_id,worker_id,pid,process_group_id,command_summary,started_at,pid_start_time,process_kind) VALUES (?,?,?,?,?,?,?,?,?)", `process-${worker.id}`, task.id, worker.id, processId, processIdentity?.processGroupId ?? processId, "pi --mode rpc --session", startedAt, processIdentity?.startTime ?? null, "PI");
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
      principalBrokered ? `Execution Principal ${worker.principalId}; workspace ${worker.workspaceId ?? "default"}. Use worker_exec and worker workspace tools for every file/process operation; the model process has no workspace mount.` : `Workspace: ${projectPath}`,
      inboundFiles.length ? `Authorized inbound files (materialized in the workspace):\n${inboundFiles.join("\n")}` : "No inbound files were supplied.",
      imageInputs.length ? `${imageInputs.length} authorized image input(s) are attached to this Pi turn as visual content.` : "No visual image inputs were attached to this Pi turn.",
      "Do not send chat messages or access credentials. Return a concise verified result.",
      `Runtime control frames must be separate lines prefixed with ${WORKER_CONTROL_PREFIX.trimEnd()} and contain JSON. Supported types are progress, question, artifact, and finish.`,
      `Use ${WORKER_CONTROL_PREFIX}{"type":"progress","summary":"..."} for meaningful progress; use question with a question field; use artifact with a workspace-relative path; use finish with outcome COMPLETED, PARTIAL, or FAILED and a summary.`,
      "Plain text is only a result summary. It never grants authorization or changes Runtime state.",
    ].join("\n");
    try {
      const useWorkerExtension = Boolean(this.options.workerToolExtensionPath && (mcpToken || principalBrokered));
      const timeoutMs = task.trust === "GUEST" ? Math.min(this.config.runtime.piTimeoutMs, this.remainingGuestTaskMs(task)) : this.config.runtime.piTimeoutMs;
      const outputPromise = this.pi.send(session, prompt, { cwd: piCwd, sandbox, timeoutMs, taskId: task.id, workerId: worker.id, ...(useWorkerExtension ? { extensionPath: this.options.workerToolExtensionPath } : {}), ...(principalBrokered ? { mainTools: true } : {}), ...(imageInputs.length ? { images: imageInputs } : {}) });
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

  async answerQuestion(questionId: string, answer: string, source: { message: PlatformMessageRef; conversationId: string; requester?: TaskRequester; trust?: "OWNER" | "GUEST"; capabilities?: CapabilitySet }): Promise<void> {
    const question = this.db.get<{ id: string; task_id: string; worker_id: string; status: string }>("SELECT id,task_id,worker_id,status FROM pending_questions WHERE id=?", questionId);
    if (!question || question.status !== "OPEN") throw new Error("QUESTION_NOT_OPEN");
    const task = this.getTask(question.task_id);
    if (this.getWorker(question.worker_id).status !== "WAITING_USER") throw new Error("QUESTION_NOT_OPEN");
    if (this.isTerminalTask(task.status) || this.cancellationRequested(task.id)) throw new Error("QUESTION_NOT_OPEN");
    if (source.requester && !this.taskOwnedByActor(task, source.requester.principalId, source.requester)) throw new Error("QUESTION_ANSWER_DENIED");
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

  async addFollowUp(taskId: string, content: string, source: { conversationId: string; message: PlatformMessageRef; requester?: TaskRequester; capabilities?: CapabilitySet }): Promise<void> {
    const task = this.getTask(taskId);
    if (!task.capabilities.tasks.canFollowUp || this.isTerminalTask(task.status) || this.cancellationRequested(taskId)) throw new Error("TASK_FOLLOW_UP_DENIED");
    if (source.requester && !this.taskOwnedByActor(task, source.requester.principalId, source.requester)) throw new Error("TASK_FOLLOW_UP_DENIED");
    if (source.capabilities) {
      const actor = validateCapabilitySet(source.capabilities);
      if (!actor.tasks.canFollowUp || !actor.qq.sendConversations.includes(source.conversationId)) throw new Error("TASK_FOLLOW_UP_DENIED");
    }
    const targetWorker = this.db.get<{ id: string }>("SELECT id FROM worker_executions WHERE task_id=? AND status IN ('PENDING','STARTING','RUNNING','WAITING_USER') ORDER BY CASE status WHEN 'RUNNING' THEN 0 WHEN 'WAITING_USER' THEN 1 WHEN 'STARTING' THEN 2 ELSE 3 END, updated_at DESC LIMIT 1", taskId);
    if (!targetWorker) {
      if (!source.requester || !source.capabilities?.tasks.canCreate) throw new Error("TASK_FOLLOW_UP_WORKER_CREATE_DENIED");
      const mailboxId = newId("mail");
      const timestamp = nowIso();
      this.db.transaction(() => {
        this.db.run("INSERT INTO task_mailbox(id,task_id,type,source_conversation_id,source_message_key,content,status,created_at) VALUES (?,?,?,?,?,?,?,?)", mailboxId, taskId, "FOLLOW_UP", source.conversationId, messageKey(source.message), content, "PENDING", timestamp);
        this.event(taskId, "FOLLOW_UP_ADDED", undefined, { mailboxId, delegatedToNewWorker: true });
      });
      try { await this.dispatchFollowUpAsWorker(mailboxId, task, content, source.capabilities, source.requester); }
      catch (error) { this.db.run("UPDATE task_mailbox SET status='FAILED' WHERE id=? AND status IN ('PENDING','PROCESSING')", mailboxId); this.recordException(taskId, undefined, "follow_up_dispatch", "FOLLOW_UP_WORKER_CREATE", String(error)); throw error; }
      return;
    }
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
      } catch (error) {
        const currentStatus = this.getWorker(targetWorker.id).status;
        if (["COMPLETED", "FAILED", "CANCELLED", "INTERRUPTED"].includes(currentStatus)) {
          try { await this.dispatchFollowUpAsWorker(id, task, content, source.capabilities, source.requester); }
          catch (dispatchError) { this.db.run("UPDATE task_mailbox SET status='FAILED' WHERE id=? AND status IN ('PENDING','DELIVERED','PROCESSING')", id); this.recordException(taskId, undefined, "follow_up_dispatch", "FOLLOW_UP_WORKER_CREATE", String(dispatchError)); throw dispatchError; }
        } else this.recordException(taskId, targetWorker.id, "addFollowUp", "WORKER_DELIVERY", String(error));
      }
    }
  }

  async requestCancel(taskId: string, actor?: CapabilitySet, actorPrincipalId?: string, actorRequester?: TaskRequester, internalReason?: string): Promise<void> {
    const task = this.getTask(taskId);
    if (actor) {
      const checked = validateCapabilitySet(actor);
      if (!checked.tasks.canCancel) throw new Error("TASK_CANCEL_DENIED");
      if (!this.taskVisibleToActor(task, checked, actorPrincipalId, actorRequester)) throw new Error("TASK_CANCEL_DENIED");
    }
    if (!internalReason && !task.capabilities.tasks.canCancel) throw new Error("TASK_CANCEL_DENIED");
    if (this.isTerminalTask(task.status)) throw new Error("TASK_CANCEL_DENIED");
    const workers = this.db.all<{ id: string; status: WorkerStatus; workspace_id: string | null; workspace_scope_id: string | null; process_mode: string; runtime_uid: number | null; harness_session_id: string | null; harness_session_path: string | null; process_id: number | null; process_group_id: number | null; pid_start_time: string | null }>("SELECT w.id,w.status,w.workspace_id,w.workspace_scope_id,w.process_mode,w.runtime_uid,w.harness_session_id,w.harness_session_path,w.process_id,op.process_group_id,op.pid_start_time FROM worker_executions w LEFT JOIN owned_processes op ON op.worker_id=w.id AND op.process_kind='PI' WHERE w.task_id=? AND w.status IN ('PENDING','STARTING','RUNNING','WAITING_USER','STOPPING')", taskId);
    this.db.transaction(() => {
      this.event(taskId, "CANCEL_REQUESTED", undefined, internalReason ? { reason: internalReason } : {});
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
        if (worker.workspace_scope_id ?? worker.workspace_id) this.db.run("DELETE FROM project_locks WHERE project_id=? AND owner_worker_id=?", worker.workspace_scope_id ?? worker.workspace_id as string, worker.id);
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
    for (const worker of workers) if (isPrincipalBrokered(worker.process_mode) && worker.runtime_uid && worker.runtime_uid !== OWNER_RUNTIME_UID) await this.cleanupPrincipalProcesses(worker.runtime_uid);
  }

  async quiesceForBackup(): Promise<void> {
    const workers = this.db.all<{ id: string; task_id: string; workspace_id: string | null; workspace_scope_id: string | null; process_mode: string; runtime_uid: number | null; harness_session_id: string | null; harness_session_path: string | null; process_id: number | null; process_group_id: number | null; pid_start_time: string | null }>("SELECT w.id,w.task_id,w.workspace_id,w.workspace_scope_id,w.process_mode,w.runtime_uid,w.harness_session_id,w.harness_session_path,w.process_id,op.process_group_id,op.pid_start_time FROM worker_executions w LEFT JOIN owned_processes op ON op.worker_id=w.id AND op.process_kind='PI' WHERE w.status IN ('PENDING','STARTING','RUNNING','WAITING_USER','STOPPING')");
    for (const worker of workers) {
      if (!await this.stopWorkerExecution(worker)) throw new Error(`BACKUP_WORKER_TERMINATION_UNCONFIRMED:${worker.id}`);
    }
    const timestamp = nowIso();
    this.db.transaction(() => {
      for (const worker of workers) {
        const update = this.db.run("UPDATE worker_executions SET status='INTERRUPTED',finished_at=?,updated_at=? WHERE id=? AND status IN ('PENDING','STARTING','RUNNING','WAITING_USER','STOPPING')", timestamp, timestamp, worker.id);
        if (update.changes === 0) continue;
        if (worker.workspace_scope_id ?? worker.workspace_id) this.db.run("DELETE FROM project_locks WHERE project_id=? AND owner_worker_id=?", worker.workspace_scope_id ?? worker.workspace_id as string, worker.id);
        this.db.run("DELETE FROM owned_processes WHERE worker_id=?", worker.id);
        this.db.run("UPDATE pending_questions SET status='CLOSED',closed_at=? WHERE worker_id=? AND status='OPEN'", timestamp, worker.id);
        this.event(worker.task_id, "WORKER_INTERRUPTED", worker.id, { reason: "backup" });
        this.event(worker.task_id, "TASK_INTERRUPTED", worker.id, { reason: "backup" });
        this.db.run("UPDATE tasks SET status='INTERRUPTED',updated_at=? WHERE id=? AND status NOT IN ('COMPLETED','PARTIAL','FAILED','CANCELLED')", timestamp, worker.task_id);
        this.activeSessions.delete(worker.id);
      }
    });
    for (const worker of workers) await this.revokeWorkerBinding(worker.id);
    for (const worker of workers) if (isPrincipalBrokered(worker.process_mode) && worker.runtime_uid && worker.runtime_uid !== OWNER_RUNTIME_UID && !(await this.cleanupPrincipalProcesses(worker.runtime_uid))) throw new Error(`PRINCIPAL_PROCESS_CLEANUP_UNCONFIRMED:${worker.id}`);
  }

  async expireGuestTasks(): Promise<number> {
    const rows = this.db.all<{ id: string }>("SELECT id FROM tasks WHERE trust='GUEST' AND status IN ('CREATED','QUEUED','RUNNING','WAITING_USER','PAUSED','INTERRUPTED')");
    let expired = 0;
    for (const row of rows) {
      const task = this.getTask(row.id);
      if (this.remainingGuestTaskMs(task) > 0) continue;
      this.recordException(task.id, undefined, "guest_task", "GUEST_TASK_TIMEOUT", "Guest Task exceeded its configured wall-clock limit");
      await this.requestCancel(task.id, undefined, undefined, undefined, "GUEST_TASK_TIMEOUT");
      expired += 1;
    }
    return expired;
  }

  async finishWorker(workerId: string, result: { outcome: "COMPLETED" | "PARTIAL" | "FAILED"; summary: string; artifacts?: string[] }): Promise<void> {
    const worker = this.getWorker(workerId);
    if (!["STARTING", "RUNNING", "WAITING_USER"].includes(worker.status) || this.cancellationRequested(worker.taskId)) return;
    if (isPrincipalBrokered(worker.processMode) && worker.runtimeUid) {
      if (!(await this.terminatePrincipalCommands(workerId)) || (worker.runtimeUid !== OWNER_RUNTIME_UID && !(await this.cleanupPrincipalProcesses(worker.runtimeUid)))) {
        this.recordException(worker.taskId, workerId, "principal_process_cleanup", "PROCESS_STATE_UNKNOWN", "Principal process cleanup could not be confirmed");
        return;
      }
    }
    const status: WorkerStatus = result.outcome === "COMPLETED" ? "COMPLETED" : result.outcome === "PARTIAL" ? "COMPLETED" : "FAILED";
    const timestamp = nowIso();
    const finished = this.db.transaction(() => {
      const update = this.db.run("UPDATE worker_executions SET status=?,finished_at=?,updated_at=? WHERE id=? AND status IN ('STARTING','RUNNING','WAITING_USER')", status, timestamp, timestamp, workerId);
      if (update.changes === 0) return false;
      if (worker.workspaceScopeId ?? worker.workspaceId) this.db.run("DELETE FROM project_locks WHERE project_id=? AND owner_worker_id=?", worker.workspaceScopeId ?? worker.workspaceId as string, workerId);
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
          ...(worker.principalId ? { sourcePrincipalId: worker.principalId } : {}),
          ...(this.getTask(worker.taskId).trust === "GUEST" ? { principalQuotaBytes: this.config.guest.artifactQuotaBytes } : {}),
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
      }
    });
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
    if (worker.runtimeUid && isPrincipalBrokered(worker.processMode)) {
      if (!(await this.terminatePrincipalCommands(workerId)) || (worker.runtimeUid !== OWNER_RUNTIME_UID && !(await this.cleanupPrincipalProcesses(worker.runtimeUid)))) {
        this.recordException(worker.taskId, workerId, "principal_process_cleanup", "PROCESS_STATE_UNKNOWN", "Principal process cleanup could not be confirmed");
        return;
      }
    }
    const failure = workerFailureDetail(error);
    const timestamp = nowIso();
    const failed = this.db.transaction(() => {
      const update = this.db.run("UPDATE worker_executions SET status='FAILED',finished_at=?,updated_at=? WHERE id=? AND status IN ('STARTING','RUNNING','WAITING_USER')", timestamp, timestamp, workerId);
      if (update.changes === 0) return false;
      if (worker.workspaceScopeId ?? worker.workspaceId) this.db.run("DELETE FROM project_locks WHERE project_id=? AND owner_worker_id=?", worker.workspaceScopeId ?? worker.workspaceId as string, workerId);
      this.db.run("DELETE FROM owned_processes WHERE worker_id=?", workerId);
      this.event(worker.taskId, "WORKER_FAILED", workerId, { error: error.slice(0, 1000) });
      this.event(worker.taskId, "TASK_RESULT", workerId, { outcome: "FAILED", errorCode: failure.errorCode, summary: failure.summary });
      this.db.run("UPDATE tasks SET status='RUNNING',updated_at=? WHERE id=?", timestamp, worker.taskId);
      this.event(worker.taskId, "TASK_AWAITING_COMPLETION", undefined, { outcome: "FAILED" });
      return true;
    });
    if (!failed) return;
    this.activeSessions.delete(workerId);
    await this.revokeWorkerBinding(workerId);
    this.recordException(worker.taskId, workerId, "worker", failure.errorCode, failure.summary, false);
    await this.emit({ type: "TASK_RESULT", taskId: worker.taskId, workerId, payload: { outcome: "FAILED", errorCode: failure.errorCode, summary: failure.summary } });
    void this.schedulePendingWorkers(worker.taskId);
  }

  private async stopWorkerExecution(worker: { id: string; process_mode?: string; runtime_uid?: number | null; harness_session_id: string | null; harness_session_path: string | null; process_id: number | null; process_group_id: number | null; pid_start_time: string | null }): Promise<boolean> {
    const active = this.activeSessions.get(worker.id);
    let piTerminated = true;
    if (active) piTerminated = await this.pi.abort(active);
    else if (worker.process_id) {
      if (!worker.harness_session_id || !worker.process_group_id || !worker.pid_start_time || !this.pi.terminateProcess) piTerminated = false;
      else piTerminated = await this.pi.terminateProcess(
        { sessionId: worker.harness_session_id, sessionPath: worker.harness_session_path ?? this.workerSessionPath(worker.id) },
        { pid: worker.process_id, processGroupId: worker.process_group_id, startTime: worker.pid_start_time },
      );
    }
    const commandsTerminated = await this.terminatePrincipalCommands(worker.id);
    const principalProcessesTerminated = !isPrincipalBrokered(worker.process_mode) || !worker.runtime_uid || worker.runtime_uid === OWNER_RUNTIME_UID || await this.cleanupPrincipalProcesses(worker.runtime_uid);
    return piTerminated && commandsTerminated && principalProcessesTerminated;
  }

  async recover(): Promise<void> {
    await this.terminateOrphanedPrincipalCommands();
    this.reconcileMissingWorkerCapabilitySnapshots();
    const active = this.db.all<{
      id: string; task_id: string; workspace_id: string | null; harness_session_id: string | null; harness_session_path: string | null;
      process_id: number | null; status: WorkerStatus; owned_pid: number | null;
      process_group_id: number | null; pid_start_time: string | null;
    }>("SELECT w.id,w.task_id,w.workspace_id,w.harness_session_id,w.harness_session_path,w.process_id,w.status,op.pid AS owned_pid,op.process_group_id,op.pid_start_time FROM worker_executions w LEFT JOIN owned_processes op ON op.worker_id=w.id AND op.process_kind='PI' WHERE w.status IN ('STARTING','RUNNING','WAITING_USER','STOPPING')");
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
    await this.recoverPendingFollowUps();
  }

  private async dispatchFollowUpAsWorker(mailboxId: string, task: TaskRecord, content: string, sourceCapabilities?: CapabilitySet, sourceRequester?: TaskRequester): Promise<WorkerExecutionRecord> {
    const existing = this.db.get<{ id: string }>("SELECT id FROM worker_executions WHERE source_mailbox_id=?", mailboxId);
    if (existing) {
      const worker = this.getWorker(existing.id);
      const timestamp = nowIso();
      this.db.run("UPDATE task_mailbox SET worker_id=?,status='CONSUMED',delivered_at=COALESCE(delivered_at,?),consumed_at=COALESCE(consumed_at,?) WHERE id=?", worker.id, timestamp, timestamp, mailboxId);
      return worker;
    }
    if (this.isTerminalTask(task.status) || !task.capabilities.tasks.canFollowUp || this.cancellationRequested(task.id)) throw new Error("TASK_FOLLOW_UP_DENIED");
    const requester = sourceRequester ?? task.requester;
    const actor = validateCapabilitySet(sourceCapabilities ?? {
      ...task.capabilities,
      tasks: { ...task.capabilities.tasks, canCreate: true, visibleTaskIds: [...new Set([...task.capabilities.tasks.visibleTaskIds, task.id])] },
    });
    if (!actor.tasks.canCreate) throw new Error("TASK_FOLLOW_UP_WORKER_CREATE_DENIED");
    const previousWorkspace = this.db.get<{ workspace_id: string | null }>("SELECT workspace_id FROM worker_executions WHERE task_id=? AND workspace_id IS NOT NULL ORDER BY updated_at DESC LIMIT 1", task.id)?.workspace_id;
    const worker = await this.createWorker({
      taskId: task.id,
      objective: `Continue Task: ${task.title}\nOriginal goal: ${task.goal}\nUser follow-up: ${content}`,
      ...(previousWorkspace ? { workspaceId: previousWorkspace } : {}),
      sourceMailboxId: mailboxId,
      actor,
      actorPrincipalId: requester.principalId,
      actorRequester: requester,
    });
    const timestamp = nowIso();
    this.db.run("UPDATE task_mailbox SET worker_id=?,status='CONSUMED',delivered_at=?,consumed_at=? WHERE id=? AND status IN ('PENDING','DELIVERED','PROCESSING')", worker.id, timestamp, timestamp, mailboxId);
    this.log.info("Task follow-up dispatched to a new Worker", { taskId: task.id, workerId: worker.id, principalId: worker.principalId, role: task.trust, uid: worker.runtimeUid, gid: worker.runtimeGid, workspaceId: worker.workspaceId, workspaceAccess: worker.workspaceAccess, capabilities: { projects: worker.capabilities?.projects ?? [] }, executionProfile: describeExecutionProfile(worker), scope: worker.workspaceScopeId ?? worker.workspaceId, contextSource: sourceCapabilities ? "authenticated-follow-up-and-durable-task-capabilities" : "recovered-authorized-task-mailbox" });
    return worker;
  }

  private async recoverPendingFollowUps(): Promise<void> {
    const rows = this.db.all<{ id: string; task_id: string; content: string | null; worker_id: string | null }>("SELECT id,task_id,content,worker_id FROM task_mailbox WHERE type='FOLLOW_UP' AND status IN ('PENDING','DELIVERED','PROCESSING') ORDER BY created_at,id");
    for (const row of rows) {
      const task = this.getTask(row.task_id);
      if (this.isTerminalTask(task.status) || !task.capabilities.tasks.canFollowUp || this.cancellationRequested(task.id)) {
        this.db.run("UPDATE task_mailbox SET status='FAILED' WHERE id=? AND status IN ('PENDING','DELIVERED','PROCESSING')", row.id);
        this.log.warn("Pending Task follow-up discarded because its Task is no longer active", { taskId: task.id, mailboxId: row.id, workerId: row.worker_id, principalId: task.requester.principalId, role: task.trust, scope: task.originConversationId, contextSource: "durable-task-mailbox" });
        continue;
      }
      if (row.worker_id) {
        const worker = this.getWorker(row.worker_id);
        if (["STARTING", "RUNNING", "WAITING_USER", "PENDING"].includes(worker.status)) continue;
      }
      const activeWorker = this.db.get<{ id: string }>("SELECT id FROM worker_executions WHERE task_id=? AND status IN ('PENDING','STARTING','RUNNING','WAITING_USER') ORDER BY updated_at DESC LIMIT 1", task.id);
      if (activeWorker) {
        this.db.run("UPDATE task_mailbox SET worker_id=? WHERE id=? AND status IN ('PENDING','DELIVERED','PROCESSING')", activeWorker.id, row.id);
        continue;
      }
      this.db.run("UPDATE task_mailbox SET status='PROCESSING',worker_id=NULL WHERE id=? AND status IN ('PENDING','DELIVERED','PROCESSING')", row.id);
      try { await this.dispatchFollowUpAsWorker(row.id, task, row.content ?? "Continue the authorized Task."); }
      catch (error) {
        this.db.run("UPDATE task_mailbox SET status='FAILED' WHERE id=? AND status IN ('PENDING','DELIVERED','PROCESSING')", row.id);
        this.recordException(task.id, undefined, "follow_up_recovery", "FOLLOW_UP_WORKER_CREATE", String(error));
      }
    }
  }

  private async recoveryProcessState(session: PiSession | undefined, expected: PiProcessIdentity | undefined, processId: number | null): Promise<"OWNED" | "NOT_FOUND" | "FOREIGN" | "UNKNOWN"> {
    if (!processId) return "NOT_FOUND";
    if (!session || !expected || !this.pi.inspectProcess) return this.processAlive(processId) ? "UNKNOWN" : "NOT_FOUND";
    return this.pi.inspectProcess(session, expected);
  }

  private async restoreRecoveredSession(workerId: string, taskId: string, workspaceId: string | null, status: "RUNNING" | "WAITING_USER", session: PiSession): Promise<boolean> {
    const worker = this.getWorker(workerId);
    const task = this.getTask(taskId);
    if (this.options.principals && !worker.principalId) return false;
    const principalBrokered = isPrincipalBrokered(worker.processMode);
    const modelUid = this.options.modelRuntimeUid ?? MODEL_RUNTIME_UID;
    const modelGid = this.options.modelRuntimeGid ?? MODEL_RUNTIME_GID;
    const projectPath = this.workerWorkspace(worker);
    let workerToolContext: { token: string; socketPath: string } | undefined;
    if (principalBrokered) {
      if (!worker.principalId || !this.options.principals) return false;
      if (process.getuid?.() !== 0) return false;
      await this.options.principals.ensurePrincipalDirectories(worker.principalId);
      await this.options.principals.workspacePath(worker.principalId, workspaceId ?? "default");
      await this.ensureSystemPrivateDirectory(dirname(session.sessionPath), modelUid, modelGid);
      workerToolContext = await this.prepareGuestToolContext(worker, task);
    } else {
      await this.ensureSystemPrivateDirectory(dirname(session.sessionPath));
      await mkdir(projectPath, { recursive: true, mode: 0o700 });
    }
    const mcpToken = await this.ensureWorkerBinding(workerId);
    const sandbox: PiSandbox = { sessionRoot: dirname(session.sessionPath), ...(principalBrokered ? { launcherUid: modelUid, launcherGid: modelGid } : {}), ...(workerToolContext ? { toolSocket: workerToolContext.socketPath, toolToken: workerToolContext.token } : {}) };
    const useWorkerExtension = Boolean(this.options.workerToolExtensionPath && (mcpToken || principalBrokered));
    if (!await this.pi.resumeSession(session, { cwd: dirname(session.sessionPath), sandbox, ...(useWorkerExtension ? { extensionPath: this.options.workerToolExtensionPath } : {}), ...(principalBrokered ? { mainTools: true } : {}) })) return false;
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
      if (releaseLock && workspaceId) this.db.run("DELETE FROM project_locks WHERE project_id=? AND owner_worker_id=?", this.workspaceScopeId(this.getTask(taskId), workspaceId), workerId);
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
      if (workspaceId) this.db.run("DELETE FROM project_locks WHERE project_id=? AND owner_worker_id=?", this.workspaceScopeId(this.getTask(taskId), workspaceId), workerId);
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

  private reconcileMissingWorkerCapabilitySnapshots(): void {
    const rows = this.db.all<{ id: string; task_id: string; workspace_id: string | null; workspace_access: WorkerExecutionRecord["workspaceAccess"]; principal_id: string | null }>("SELECT id,task_id,workspace_id,workspace_access,principal_id FROM worker_executions WHERE capabilities_json IS NULL OR capabilities_json='' ");
    for (const worker of rows) {
      if (!worker.principal_id || !worker.workspace_id || (worker.workspace_access !== "READ" && worker.workspace_access !== "WRITE")) continue;
      const task = this.getTask(worker.task_id);
      const requested = defaultWorkerCapabilityRequest(task, worker.workspace_id, worker.workspace_access);
      const capabilities = attenuateWorker(task.capabilities, requested);
      const changed = this.db.run("UPDATE worker_executions SET capabilities_json=? WHERE id=? AND (capabilities_json IS NULL OR capabilities_json='')", JSON.stringify(capabilities), worker.id).changes;
      if (changed) {
        const principal = this.options.principals?.get(worker.principal_id);
        this.log.warn("Missing Worker capability snapshot reconstructed from durable Task and profile", { taskId: task.id, workerId: worker.id, principalId: worker.principal_id, role: principal?.role ?? task.trust, uid: principal?.runtimeUid ?? null, gid: principal?.runtimeGid ?? null, workspaceId: worker.workspace_id, workspace: this.options.principals?.workspacePathSync(worker.principal_id, worker.workspace_id), workspaceAccess: worker.workspace_access, capabilities: { projects: capabilities.projects }, executionProfile: describeExecutionProfile({ processMode: "PRINCIPAL_BROKERED", workspaceAccess: worker.workspace_access } as WorkerExecutionRecord), scope: this.workspaceScopeId(task, worker.workspace_id), contextSource: "durable-task-capabilities-plus-durable-worker-profile" });
      }
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
    await this.options.mcpControl.registerWorkerBinding({ token, taskId: worker.taskId, workerId, allowedActions: worker.capabilities?.plugins.allowedActions ?? [], ...(worker.capabilities?.plugins.allowedPermissions !== undefined ? { allowedPermissions: worker.capabilities.plugins.allowedPermissions } : {}) });
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
    const rows = this.db.all<{ id: string; task_id: string; workspace_id: string | null; workspace_scope_id: string | null; workspace_access: WorkerExecutionRecord["workspaceAccess"] }>(
      taskId
        ? "SELECT id,task_id,workspace_id,workspace_scope_id,workspace_access FROM worker_executions WHERE task_id=? AND status='PENDING' ORDER BY updated_at,id"
        : "SELECT id,task_id,workspace_id,workspace_scope_id,workspace_access FROM worker_executions WHERE status='PENDING' ORDER BY updated_at,id",
      ...(taskId ? [taskId] : []),
    );
    for (const worker of rows) {
      const active = Number(this.db.get<{ count: number }>("SELECT count(*) AS count FROM worker_executions WHERE task_id=? AND status IN ('STARTING','RUNNING','WAITING_USER','STOPPING')", worker.task_id)?.count ?? 0);
      if (active >= this.config.runtime.maxWorkers) continue;
      if (worker.workspace_access === "WRITE" && worker.workspace_scope_id && !this.tryAcquireLock(worker.workspace_scope_id, worker.id)) continue;
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
    return { id: row.id as string, title: row.title as string, goal: row.goal as string, status: row.status as TaskStatus, requester: JSON.parse(row.requester_json as string) as TaskRequester, trust: row.trust as TaskRecord["trust"], originConversationId: row.origin_conversation_id as string, notificationConversationId: row.notification_conversation_id as string, ...(row.parent_task_id ? { parentTaskId: row.parent_task_id as string } : {}), capabilities, createdAt: row.created_at as string, updatedAt: row.updated_at as string, ...(row.completed_at ? { completedAt: row.completed_at as string } : {}), ...(typeof row.deadline_at === "string" ? { deadlineAt: row.deadline_at } : {}) };
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
    return { id: row.id as string, taskId: row.task_id as string, objective: row.objective as string, status: row.status as WorkerStatus, harness: "pi", ...(row.process_mode ? { processMode: row.process_mode as WorkerExecutionRecord["processMode"] } : {}), ...(row.principal_id ? { principalId: row.principal_id as string } : {}), ...(typeof row.runtime_uid === "number" ? { runtimeUid: row.runtime_uid } : {}), ...(typeof row.runtime_gid === "number" ? { runtimeGid: row.runtime_gid } : {}), ...(row.harness_session_id ? { harnessSessionId: row.harness_session_id as string } : {}), ...(row.workspace_id ? { workspaceId: row.workspace_id as string } : {}), ...(row.workspace_scope_id ? { workspaceScopeId: row.workspace_scope_id as string } : {}), ...(row.workspace_access ? { workspaceAccess: row.workspace_access as "READ" | "WRITE" } : {}), ...(capabilities ? { capabilities } : {}), ...(artifactRefs?.length ? { artifactRefs } : {}), ...(row.process_id ? { processId: row.process_id as number } : {}), ...(row.started_at ? { startedAt: row.started_at as string } : {}), updatedAt: row.updated_at as string, ...(row.finished_at ? { finishedAt: row.finished_at as string } : {}) };
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
      if (this.options.principals) return Boolean(requesterPrincipalId && task.requester.principalId === requesterPrincipalId);
      return requesterPrincipalId && task.requester.principalId
        ? task.requester.principalId === requesterPrincipalId
        : task.requester.userId === requesterId;
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

  private event(taskId: string, type: string, workerId?: string, payload: Record<string, unknown> = {}, notifyMain = true): void {
    const eventId = newId("taskevt");
    const createdAt = nowIso();
    this.db.run("INSERT INTO task_events(id,task_id,worker_id,type,payload_json,created_at) VALUES (?,?,?,?,?,?)", eventId, taskId, workerId ?? null, type, JSON.stringify(payload), createdAt);
    if (notifyMain && MAIN_EVENT_TYPES.has(type)) {
      this.db.run("INSERT INTO task_event_outbox(task_event_id,task_id,event_type,question_id,payload_json,status,attempts,created_at) VALUES (?,?,?,?,?,?,?,?)", eventId, taskId, type, typeof payload.questionId === "string" ? payload.questionId : null, JSON.stringify(payload), "PENDING", 0, createdAt);
    }
  }

  private recordException(taskId: string, workerId: string | undefined, operation: string, category: string, summary: string, notifyMain = true): void {
    const bounded = summary.slice(0, 2000);
    this.db.run("INSERT INTO runtime_exceptions(id,task_id,worker_id,operation,category,summary,created_at) VALUES (?,?,?,?,?,?,?)", newId("exception"), taskId, workerId ?? null, operation, category, bounded, nowIso());
    this.event(taskId, "TASK_EXCEPTION", workerId, { operation, category, summary: bounded }, notifyMain);
    if (notifyMain) void this.emit({ type: "TASK_EXCEPTION", taskId, workerId, payload: { operation, category, summary: bounded } });
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
      const parsedControl = parseWorkerControlFrame(line.slice(WORKER_CONTROL_PREFIX.length));
      const value: unknown = parsedControl.frame;
      if (parsedControl.trailing.trim()) text.push(parsedControl.trailing.trim());
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
    if (worker.workspaceId && worker.principalId && this.options.principals) return this.options.principals.workspacePathSync(worker.principalId, worker.workspaceId);
    const fallback = worker.workspaceId ? join(this.options.workerRoot, "projects", canonicalWorkspaceId(worker.workspaceId)) : join(this.options.workerRoot, "scratch", worker.id);
    this.log.warn("Non-Principal Worker workspace fallback selected", { taskId: worker.taskId, workerId: worker.id, principalId: worker.principalId, workspaceId: worker.workspaceId, workspace: fallback, executionProfile: describeExecutionProfile(worker), scope: worker.workspaceScopeId ?? worker.workspaceId, contextSource: worker.principalId && !this.options.principals ? "principal-service-unavailable" : "legacy-worker-without-principal" });
    return fallback;
  }

  private async ensureSystemPrivateDirectory(path: string, uid?: number, gid?: number): Promise<void> {
    await mkdir(path, { recursive: true, mode: 0o700 });
    if (uid !== undefined || gid !== undefined) {
      if (uid === undefined || gid === undefined) throw new Error("WORKER_ORCHESTRATOR_IDENTITY_INCOMPLETE");
      if (process.getuid?.() !== 0 || process.getgid?.() !== 0) throw new Error("WORKER_ORCHESTRATOR_PROVISION_REQUIRES_ROOT");
      await chown(path, uid, gid);
    }
    await chmod(path, 0o700);
  }

  private workerSessionPath(workerId: string): string {
    return join(this.options.modelSessionsRoot ?? join(this.options.workerRoot, "model", "sessions", "workers"), workerId, "session.jsonl");
  }

  private async recoverySessionPath(workerId: string, storedPath: string | null): Promise<string> {
    const isolated = this.workerSessionPath(workerId);
    const modelSessionsRoot = this.options.modelSessionsRoot ?? join(this.options.workerRoot, "model", "sessions");
    if (storedPath && this.pathWithinWorkerRoot(modelSessionsRoot, storedPath)) return storedPath;
    try { await access(isolated); return isolated; } catch { /* try the pre-isolation layout below */ }
    return isolated;
  }

  private pathWithinWorkerRoot(root: string, path: string): boolean {
    const relativePath = relative(resolve(root), resolve(path));
    return relativePath === "" || (relativePath !== ".." && !relativePath.startsWith(`..${path.includes("\\") ? "\\" : "/"}`));
  }

  private conversationAllowed(conversations: string[], conversationId: string): boolean {
    return conversations.includes("*") || conversations.includes(conversationId);
  }

  private taskVisibleToActor(task: TaskRecord, actor: CapabilitySet, actorPrincipalId?: string, actorRequester?: TaskRequester): boolean {
    if (actor.tasks.visibleTaskIds.includes(task.id)) return true;
    if (task.requester.principalId) return Boolean(actorPrincipalId && task.requester.principalId === actorPrincipalId);
    if (this.options.principals) return false;
    if (actorRequester) return this.taskOwnedToLegacyRequester(task, actorRequester);
    // Pre-Principal legacy records are visible only during backward-compatible
    // service-level operations. All new Runtime requests carry a Principal.
    return actor.qq.sendConversations.includes(task.originConversationId) || actor.qq.sendConversations.includes(task.notificationConversationId);
  }

  private taskOwnedByActor(task: TaskRecord, actorPrincipalId?: string, actorRequester?: TaskRequester): boolean {
    if (task.requester.principalId) return Boolean(actorPrincipalId && actorPrincipalId === task.requester.principalId);
    if (this.options.principals) return false;
    return Boolean(actorRequester && this.taskOwnedToLegacyRequester(task, actorRequester));
  }

  private taskOwnedToLegacyRequester(task: TaskRecord, requester: TaskRequester): boolean {
    return task.requester.platform === requester.platform && task.requester.accountId === requester.accountId && task.requester.userId === requester.userId;
  }

  private async terminateProcessGroup(pid: number, processGroupId: number, startTime: string): Promise<boolean> {
    const current = await this.readProcessIdentity(pid);
    if (current && (current.startTime !== startTime || current.processGroupId !== processGroupId)) return false;
    try { process.kill(-processGroupId, 0); } catch { return true; }
    try { process.kill(-processGroupId, "SIGTERM"); } catch { return false; }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
    try { process.kill(-processGroupId, 0); } catch { return true; }
    try { process.kill(-processGroupId, "SIGKILL"); } catch { return false; }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    try { process.kill(-processGroupId, 0); return false; } catch { return true; }
  }

  private async terminatePrincipalCommand(workerId: string, child: ChildProcess): Promise<boolean> {
    if (!child.pid && child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolvePromise) => {
        const finish = () => { child.removeListener("spawn", finish); child.removeListener("error", finish); child.removeListener("exit", finish); resolvePromise(); };
        child.once("spawn", finish);
        child.once("error", finish);
        child.once("exit", finish);
      });
    }
    if (!child.pid) return true;
    const current = await this.readProcessIdentity(child.pid);
    return this.terminateProcessGroup(child.pid, current?.processGroupId ?? child.pid, current?.startTime ?? "leader-exited");
  }

  private async terminatePrincipalCommands(workerId: string): Promise<boolean> {
    let confirmed = true;
    for (const child of this.activePrincipalCommands.get(workerId) ?? []) if (!(await this.terminatePrincipalCommand(workerId, child))) confirmed = false;
    const rows = this.db.all<{ id: string; pid: number; process_group_id: number | null; pid_start_time: string | null }>("SELECT id,pid,process_group_id,pid_start_time FROM owned_processes WHERE worker_id=? AND process_kind IN ('PRINCIPAL_EXEC','GUEST_EXEC')", workerId);
    for (const row of rows) {
      if (!row.process_group_id || !row.pid_start_time || !(await this.terminateProcessGroup(row.pid, row.process_group_id, row.pid_start_time))) confirmed = false;
      else this.db.run("DELETE FROM owned_processes WHERE id=?", row.id);
    }
    return confirmed;
  }

  private async terminateOrphanedPrincipalCommands(): Promise<void> {
    const rows = this.db.all<{ id: string; worker_id: string; pid: number; process_group_id: number | null; pid_start_time: string | null }>("SELECT id,worker_id,pid,process_group_id,pid_start_time FROM owned_processes WHERE process_kind IN ('PRINCIPAL_EXEC','GUEST_EXEC')");
    for (const row of rows) {
      if (!row.process_group_id || !row.pid_start_time || !(await this.terminateProcessGroup(row.pid, row.process_group_id, row.pid_start_time))) throw new Error(`PRINCIPAL_PROCESS_RECOVERY_UNCONFIRMED:${row.worker_id}`);
      this.db.run("DELETE FROM owned_processes WHERE id=?", row.id);
    }
  }

  private async cleanupPrincipalProcesses(runtimeUid: number): Promise<boolean> {
    const entries = await readdir("/proc", { withFileTypes: true });
    const processGroups = new Set<number>();
    for (const entry of entries) {
      if (!/^\d+$/.test(entry.name)) continue;
      try {
        const [statLine, status] = await Promise.all([readFile(`/proc/${entry.name}/stat`, "utf8"), readFile(`/proc/${entry.name}/status`, "utf8")]);
        const close = statLine.lastIndexOf(")");
        const fields = statLine.slice(close + 2).trim().split(/\s+/);
        const group = Number(fields[2]);
        const uidLine = status.split("\n").find((line) => line.startsWith("Uid:"));
        const effectiveUid = uidLine ? Number(uidLine.trim().split(/\s+/)[2]) : -1;
        if (effectiveUid === runtimeUid && Number.isInteger(group)) processGroups.add(group);
      } catch { /* process exited while enumerating */ }
    }
    let terminated = true;
    for (const group of processGroups) {
      try { process.kill(-group, "SIGTERM"); } catch { continue; }
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
    for (const group of processGroups) {
      try { process.kill(-group, "SIGKILL"); } catch { /* already exited */ }
      try { process.kill(-group, 0); terminated = false; } catch { /* confirmed gone */ }
    }
    return terminated;
  }

  private isTerminalTask(status: TaskStatus): boolean {
    return ["COMPLETED", "PARTIAL", "FAILED", "CANCELLED"].includes(status);
  }

  private remainingGuestTaskMs(task: TaskRecord): number {
    if (task.trust !== "GUEST") return this.config.runtime.piTimeoutMs;
    const deadline = task.deadlineAt ? Date.parse(task.deadlineAt) : Date.parse(task.createdAt) + (this.config.guest?.taskTimeoutMs ?? 30 * 60 * 1000);
    return Math.max(0, deadline - Date.now());
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

  private activeRequesterTaskCount(requester: TaskRequester): number {
    const rows = this.db.all<{ requester_json: string }>("SELECT requester_json FROM tasks WHERE status IN ('CREATED','QUEUED','RUNNING','WAITING_USER','PAUSED','INTERRUPTED')");
    return rows.reduce((count, row) => {
      try {
        const current = JSON.parse(row.requester_json) as TaskRequester;
        const same = requester.principalId && current.principalId
          ? requester.principalId === current.principalId
          : current.platform === requester.platform && current.accountId === requester.accountId && current.userId === requester.userId;
        return count + Number(same);
      } catch { return count; }
    }, 0);
  }

  private activePrincipalTaskCount(principalId: string): number {
    return Number(this.db.get<{ count: number }>("SELECT count(*) AS count FROM tasks WHERE principal_id=? AND status IN ('CREATED','QUEUED','RUNNING','WAITING_USER','PAUSED','INTERRUPTED')", principalId)?.count ?? 0);
  }

  private activeWorkerCount(): number {
    return Number(this.db.get<{ count: number }>("SELECT count(*) AS count FROM worker_executions WHERE status IN ('PENDING','STARTING','RUNNING','WAITING_USER','STOPPING')")?.count ?? 0);
  }

  private activeProjectWorkerCount(projectId: string): number {
    return Number(this.db.get<{ count: number }>("SELECT count(*) AS count FROM worker_executions WHERE COALESCE(workspace_scope_id,workspace_id)=? AND status IN ('PENDING','STARTING','RUNNING','WAITING_USER','STOPPING')", projectId)?.count ?? 0);
  }

  private activeRequesterWorkerCount(requester: TaskRequester): number {
    const rows = this.db.all<{ requester_json: string }>("SELECT t.requester_json FROM worker_executions w JOIN tasks t ON t.id=w.task_id WHERE w.status IN ('PENDING','STARTING','RUNNING','WAITING_USER','STOPPING')");
    return rows.reduce((count, row) => {
      try {
        const current = JSON.parse(row.requester_json) as TaskRequester;
        const samePrincipal = requester.principalId && current.principalId
          ? requester.principalId === current.principalId
          : current.platform === requester.platform && current.accountId === requester.accountId && current.userId === requester.userId;
        return count + Number(samePrincipal);
      } catch {
        return count;
      }
    }, 0);
  }

  private limit(name: "maxTasks" | "maxWorkersTotal" | "maxWorkersPerProject" | "maxWorkersPerRequester" | "maxTasksPerRequester" | "maxTasksPerPrincipal"): number {
    const value = this.config.runtime[name];
    return Number.isInteger(value) && value > 0 ? value : Number.MAX_SAFE_INTEGER;
  }

  private audit(operation: string, decision: "ALLOW" | "DENY", reason: string | undefined, resource: string, requesterId?: string, taskId?: string): void {
    this.db.run("INSERT INTO authorization_audit_events(id,operation,decision,reason,resource,requester_id,task_id,metadata_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)", newId("authz"), operation, decision, reason ?? null, resource, requesterId ?? null, taskId ?? null, null, nowIso());
  }

  private canonicalCapabilities(input: { requester: TaskRequester; trust: "OWNER" | "GUEST"; originConversationId: string }): CapabilitySet | undefined {
    const owners = configuredOwners(this.config);
    if (!owners.length) return undefined;
    const row = this.db.get<{ platform: string; account_id: string; kind: "private" | "group"; platform_conversation_id: string; thread_id_json: string }>("SELECT platform,account_id,kind,platform_conversation_id,thread_id_json FROM conversations WHERE conversation_id=?", input.originConversationId);
    if (!row) return undefined;
    return deriveCapabilities({ ...input.requester, trust: input.trust, conversationId: input.originConversationId }, { platform: row.platform, accountId: row.account_id, kind: row.kind, platformConversationId: row.platform_conversation_id, threadId: JSON.parse(row.thread_id_json) }, owners, input.originConversationId, { ...this.config.plugins, guestTaskExecutionEnabled: this.config.guest?.enabled ?? true });
  }
}

function pathWithin(root: string, candidate: string): boolean {
  const child = relative(resolve(root), resolve(candidate));
  return child === "" || (child !== ".." && !child.startsWith(`..${candidate.includes("\\") ? "\\" : "/"}`));
}

function parseWorkerControlFrame(content: string): { frame: unknown; trailing: string } {
  const start = content.search(/\S/);
  if (start < 0 || content[start] !== "{") throw new Error("WORKER_CONTROL_INVALID_JSON");
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < content.length; index += 1) {
    const char = content[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') { inString = true; continue; }
    if (char === "{" || char === "[") depth += 1;
    else if (char === "}" || char === "]") {
      depth -= 1;
      if (depth < 0) throw new Error("WORKER_CONTROL_INVALID_JSON");
      if (depth === 0) {
        try { return { frame: JSON.parse(content.slice(start, index + 1)) as unknown, trailing: content.slice(index + 1) }; }
        catch { throw new Error("WORKER_CONTROL_INVALID_JSON"); }
      }
    }
  }
  throw new Error("WORKER_CONTROL_INVALID_JSON");
}

function isPrincipalBrokered(mode: string | undefined): boolean {
  return mode === "PRINCIPAL_BROKERED" || mode === "GUEST_BROKERED";
}

function shellQuote(value: string): string { return `'${value.replaceAll("'", `'\\''`)}'`; }

function defaultWorkerCapabilityRequest(task: TaskRecord, workspaceId: string | undefined, workspaceAccess: WorkerExecutionRecord["workspaceAccess"]): Partial<CapabilitySet> {
  return {
    memory: { allowedScopes: task.capabilities.memory.allowedScopes },
    projects: workspaceId && workspaceAccess ? [{ projectId: workspaceId, access: workspaceAccess }] : [],
    qq: { readConversations: [], sendConversations: [] },
    plugins: { allowedActions: task.capabilities.plugins.allowedActions, ...(task.capabilities.plugins.allowedPermissions !== undefined ? { allowedPermissions: task.capabilities.plugins.allowedPermissions } : {}) },
    artifacts: { readableArtifactAuthorities: task.capabilities.artifacts.readableArtifactAuthorities, publishTaskIds: [task.id], allowedDestinations: [] },
    tasks: { canCreate: false, visibleTaskIds: [], canCancel: false, canFollowUp: false },
  };
}

function describeExecutionProfile(worker: WorkerExecutionRecord): ExecutionContext["executionProfile"] {
  if (!worker.workspaceAccess) return "LEGACY_UNSCOPED";
  const family = isPrincipalBrokered(worker.processMode) ? "PRINCIPAL" : "LEGACY";
  return `${family}_${worker.workspaceAccess === "WRITE" ? "READ_WRITE" : "READ_ONLY"}` as ExecutionContext["executionProfile"];
}

function executionContextLogFields(context: ExecutionContext): Record<string, unknown> {
  return {
    taskId: context.taskId,
    workerId: context.workerId,
    principalId: context.principalId,
    role: context.role,
    uid: context.uid,
    gid: context.gid,
    workspaceId: context.workspaceId,
    workspace: context.workspace,
    home: context.home,
    workspaceAccess: context.workspaceAccess,
    capabilities: { projects: context.capabilities.projects },
    executionProfile: context.executionProfile,
    scope: context.workspaceScopeId ?? context.workspaceId,
    contextSource: context.contextSource,
  };
}

function classifyWorkspaceExecutionFailure(stderr: string): string {
  const runtimeCode = stderr.match(/\b(WORKSPACE_[A-Z0-9_]+)\b/)?.[1];
  return runtimeCode ?? classifyWorkspaceErrorCode(stderr.match(/\b(?:EROFS|EACCES|EPERM|ENOENT)\b/)?.[0] ?? "");
}

export function classifyWorkspaceErrorCode(code: string): string {
  if (code === "EROFS") return "WORKSPACE_FILESYSTEM_READ_ONLY";
  if (code === "EACCES" || code === "EPERM") return "WORKSPACE_UNIX_PERMISSION_DENIED";
  if (code === "ENOENT") return "WORKSPACE_PATH_NOT_FOUND";
  return "WORKSPACE_OPERATION_FAILED";
}

function workerFailureDetail(error: string): { errorCode: string; summary: string } {
  const networkHint = piNetworkFailureHint(new Error(error));
  if (networkHint) return { errorCode: "PI_NETWORK_UNAVAILABLE", summary: `Worker stopped because its model-service connection failed (${networkHint}). No verified result was produced; retry when model connectivity is restored.` };
  if (error.toLowerCase().includes("terminated")) return { errorCode: "PI_TURN_TERMINATED", summary: "Worker's Pi turn terminated before it produced a verified result." };
  const code = error.match(/\b(WORKER_[A-Z0-9_]+|WORKSPACE_[A-Z0-9_]+|PI_[A-Z0-9_]+|GUEST_[A-Z0-9_]+)\b/)?.[1] ?? "WORKER_EXECUTION_FAILED";
  return { errorCode: code, summary: `Worker stopped with ${code}; no verified result was produced.` };
}

async function readArtifactImage(path: string, artifact: { size: number; filename: string; mime?: string }): Promise<{ imageInput?: PiImageContent; reason?: string }> {
  const handle = await open(path, "r");
  let detectedMime: string | undefined;
  try {
    const prefix = Buffer.alloc(32);
    const read = await handle.read(prefix, 0, prefix.length, 0);
    detectedMime = sniffImageMimeType(prefix.subarray(0, read.bytesRead));
  } finally { await handle.close(); }
  const candidate = Boolean(detectedMime || artifact.mime?.startsWith("image/") || /\.(?:jpe?g|png|gif|webp|bmp|tiff?|avif)$/i.test(artifact.filename));
  if (!candidate) return {};
  if (artifact.size > PI_IMAGE_INPUT_MAX_BYTES) return { reason: "IMAGE_INPUT_SIZE_LIMIT" };
  const imageInput = piImageContent(await readFile(path), detectedMime ?? artifact.mime);
  return imageInput ? { imageInput } : { reason: "IMAGE_FORMAT_UNSUPPORTED" };
}

const PRINCIPAL_FILE_TOOL_SCRIPT = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const request = JSON.parse(process.argv[1]);
function workspaceErrorCode(error) {
  if (typeof error.message === "string" && /^WORKSPACE_[A-Z0-9_]+$/.test(error.message)) return error.message;
  if (error.code) return error.code;
  return "WORKSPACE_OPERATION_FAILED";
}
try {
const root = fs.realpathSync(process.cwd());
function resolveWorkspacePath(value, allowRoot = false, createParents = false) {
  if (typeof value !== "string" || path.isAbsolute(value) || value.split(/[\\/]/).some((part) => part === "..")) throw new Error("WORKSPACE_PATH_DENIED");
  if (!value && allowRoot) return root;
  if (!value || value.split(/[\\/]/).some((part) => part === "")) throw new Error("WORKSPACE_PATH_INVALID");
  const parts = value.split(/[\\/]/).filter(Boolean);
  let current = root;
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    const final = index === parts.length - 1;
    try {
      const info = fs.lstatSync(current);
      if (info.isSymbolicLink()) throw new Error("WORKSPACE_SYMLINK_DENIED");
      if (!final && !info.isDirectory()) throw new Error("WORKSPACE_PARENT_NOT_DIRECTORY");
    } catch (error) {
      if (error.code !== "ENOENT" || !createParents) throw error;
      if (!final) fs.mkdirSync(current, { mode: 0o700 });
    }
  }
  const resolved = path.resolve(current);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) throw new Error("WORKSPACE_PATH_DENIED");
  return resolved;
}
let result;
if (request.operation === "read") {
  const file = resolveWorkspacePath(request.path);
  const info = fs.statSync(file);
  if (!info.isFile() || info.size > 262144) throw new Error("WORKSPACE_READ_LIMIT");
  result = { content: fs.readFileSync(file, "utf8") };
} else if (request.operation === "write") {
  if (typeof request.content !== "string") throw new Error("WORKSPACE_CONTENT_REQUIRED");
  const file = resolveWorkspacePath(request.path, false, true);
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | (fs.constants.O_NOFOLLOW || 0), 0o600);
  try { fs.writeFileSync(fd, request.content, "utf8"); } finally { fs.closeSync(fd); }
  result = { path: request.path, bytes: Buffer.byteLength(request.content) };
} else if (request.operation === "edit") {
  if (typeof request.oldText !== "string" || !request.oldText || typeof request.newText !== "string") throw new Error("WORKSPACE_EDIT_INPUT_INVALID");
  const file = resolveWorkspacePath(request.path);
  const info = fs.statSync(file);
  if (!info.isFile() || info.size > 262144) throw new Error("WORKSPACE_EDIT_LIMIT");
  const content = fs.readFileSync(file, "utf8");
  const first = content.indexOf(request.oldText);
  if (first < 0 || content.indexOf(request.oldText, first + request.oldText.length) >= 0) throw new Error("WORKSPACE_EDIT_MATCH_MUST_BE_UNIQUE");
  const updated = content.slice(0, first) + request.newText + content.slice(first + request.oldText.length);
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_TRUNC | (fs.constants.O_NOFOLLOW || 0));
  try { fs.writeFileSync(fd, updated, "utf8"); } finally { fs.closeSync(fd); }
  result = { path: request.path, bytes: Buffer.byteLength(updated) };
} else if (request.operation === "mkdir") {
  const directory = resolveWorkspacePath(request.path, false, true);
  try { fs.mkdirSync(directory, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST" || !fs.statSync(directory).isDirectory()) throw error; }
  result = { path: request.path };
} else if (request.operation === "remove") {
  const target = resolveWorkspacePath(request.path);
  if (target === root) throw new Error("WORKSPACE_ROOT_REMOVE_DENIED");
  fs.rmSync(target, { recursive: true, force: false });
  result = { path: request.path };
} else if (request.operation === "list") {
  const directory = resolveWorkspacePath(request.path, true);
  if (!fs.statSync(directory).isDirectory()) throw new Error("WORKSPACE_NOT_DIRECTORY");
  const entries = fs.readdirSync(directory, { withFileTypes: true }).slice(0, 1000).map((entry) => ({ name: entry.name, type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other" }));
  result = { entries };
} else if (request.operation === "stat") {
  const target = resolveWorkspacePath(request.path);
  const info = fs.statSync(target);
  result = { type: info.isDirectory() ? "directory" : info.isFile() ? "file" : "other", size: info.size, mode: info.mode & 0o777 };
} else throw new Error("WORKSPACE_OPERATION_INVALID");
process.stdout.write(JSON.stringify({ ok: true, result }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, errorCode: workspaceErrorCode(error) }));
}
`;

async function directoryBytes(root: string, stopAfter: number): Promise<number> {
  let size = 0;
  const pending = [root];
  while (pending.length && size <= stopAfter) {
    const directory = pending.pop() as string;
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) {
        try { size += (await stat(path)).size; } catch { /* racing guest file */ }
        if (size > stopAfter) break;
      }
    }
  }
  return size;
}
