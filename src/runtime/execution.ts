import type { CapabilitySet } from "../shared/types.js";

/** Runtime-authenticated authority snapshot for one Worker execution. */
export interface ExecutionContext {
  executionContextId: string;
  taskId: string;
  workerId: string;
  principalId: string;
  workspaceId: string;
  workspaceScopeId?: string;
  uid: number;
  gid: number;
  workspaceGid: number;
  capabilities: CapabilitySet;
  workspace: string;
  workspaceAccess: "READ" | "WRITE";
  executionProfile: "PRINCIPAL_READ_ONLY" | "PRINCIPAL_READ_WRITE" | "LEGACY_READ_ONLY" | "LEGACY_READ_WRITE" | "LEGACY_UNSCOPED";
  contextSource: "durable-worker-record";
  home: string;
  sessionId?: string;
  groupId?: string;
}

export interface ExecutionRequest {
  command: string;
  cwd?: string;
  timeoutMs?: number;
}

/** Side effects are implemented by TaskService so they share durable Worker cancellation/recovery. */
export interface ExecutionBackend {
  executionContext(workerId: string): Promise<ExecutionContext>;
  execute(context: ExecutionContext, request: ExecutionRequest): Promise<unknown>;
  readFile(context: ExecutionContext, path: string): Promise<unknown>;
  writeFile(context: ExecutionContext, path: string, content: string): Promise<unknown>;
  editFile(context: ExecutionContext, path: string, oldText: string, newText: string): Promise<unknown>;
  makeDirectory(context: ExecutionContext, path: string): Promise<unknown>;
  removePath(context: ExecutionContext, path: string): Promise<unknown>;
  listDirectory(context: ExecutionContext, path?: string): Promise<unknown>;
  statPath(context: ExecutionContext, path: string): Promise<unknown>;
}
