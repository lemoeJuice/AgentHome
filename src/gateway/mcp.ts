import { dirname } from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AgentActionRegistry } from "./registry.js";
import type { Logger } from "../shared/logger.js";
import type { JsonValue } from "../shared/types.js";
import { newId } from "../shared/ids.js";

export type WorkerBinding = { taskId: string; workerId?: string; allowedActions: string[]; allowedPermissions?: string[] };
export type WorkerCapabilityResolver = (token: string) => WorkerBinding | undefined | Promise<WorkerBinding | undefined>;
type McpCaller = { caller: "MAIN" | "WORKER" | "CONTROL"; requesterId: string; taskId?: string; workerId?: string; allowedActions?: Set<string>; allowedPermissions?: Set<string> };

export class JsonFileMcpWorkerCapabilityResolver {
  private readonly path: string;
  constructor(path: string) { this.path = path; }

  async resolve(token: string): Promise<WorkerBinding | undefined> {
    let raw: string;
    try { raw = await readFile(this.path, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("MCP_WORKER_BINDINGS_INVALID");
    const binding = (value as Record<string, unknown>)[token];
    if (binding === undefined) return undefined;
    return validateWorkerBinding(binding);
  }
}

export class GatewayMcpServer {
  private server: Server | undefined;
  private readonly actions: AgentActionRegistry;
  private readonly port: number;
  private readonly logger: Logger;
  private readonly host: string;
  private readonly token: string | undefined;
  private readonly allowedActions: Set<string>;
  private readonly workerBindings: Map<string, WorkerBinding>;
  private readonly workerCapabilityResolver: WorkerCapabilityResolver | undefined;
  private readonly workerBindingsPath: string | undefined;
  private readonly controlToken: string | undefined;
  private readonly allowedPermissions: Set<string>;
  private readonly actionTimeoutMs: number;
  private readonly audit: ((event: { operation: string; decision: "ALLOW" | "DENY"; reason?: string; resource: string; requesterId?: string; taskId?: string }) => void) | undefined;
  constructor(actions: AgentActionRegistry, port: number, logger: Logger, options: { host?: string; token?: string; controlToken?: string; workerBindings?: Record<string, WorkerBinding>; workerBindingsPath?: string; workerCapabilityResolver?: WorkerCapabilityResolver; allowedActions?: string[]; allowedPermissions?: string[]; actionTimeoutMs?: number; audit?: (event: { operation: string; decision: "ALLOW" | "DENY"; reason?: string; resource: string; requesterId?: string; taskId?: string }) => void } = {}) {
    this.actions = actions; this.port = port; this.logger = logger; this.host = options.host ?? "0.0.0.0"; this.token = options.token; this.controlToken = options.controlToken; this.workerBindings = new Map(Object.entries(options.workerBindings ?? {}).map(([token, binding]) => [token, validateWorkerBinding(binding)])); this.workerBindingsPath = options.workerBindingsPath; this.workerCapabilityResolver = options.workerCapabilityResolver; this.allowedActions = new Set(options.allowedActions ?? []); this.allowedPermissions = new Set(options.allowedPermissions ?? []); this.actionTimeoutMs = Number.isSafeInteger(options.actionTimeoutMs) && (options.actionTimeoutMs as number) > 0 ? options.actionTimeoutMs as number : 30_000; this.audit = options.audit;
  }

  async start(): Promise<void> {
    const hasWorkerAuth = Boolean(this.workerCapabilityResolver || this.workerBindings.size);
    if (this.host !== "127.0.0.1" && this.host !== "::1" && !this.token && !hasWorkerAuth) throw new Error("MCP_TOKEN_REQUIRED_FOR_NON_LOOPBACK");
    if (this.allowedActions.size > 0 && !this.token && !hasWorkerAuth) throw new Error("MCP_TOKEN_REQUIRED_WHEN_ACTIONS_EXPOSED");
    if (this.token && [...this.workerBindings.keys()].includes(this.token)) throw new Error("MCP_TOKENS_MUST_DIFFER");
    if (this.controlToken && (this.controlToken === this.token || [...this.workerBindings.keys()].includes(this.controlToken))) throw new Error("MCP_TOKENS_MUST_DIFFER");
    for (const [token, binding] of this.workerBindings) if (!binding.taskId || token === this.token) throw new Error("MCP_WORKER_BINDING_INVALID");
    this.server = createServer((request, response) => { void this.handle(request, response); });
    await new Promise<void>((resolve, reject) => { this.server?.once("error", reject); this.server?.listen(this.port, this.host, resolve); });
    this.logger.info("Gateway MCP ready", { host: this.host, port: this.port, exposedActions: [...this.allowedActions] });
  }

  async stop(): Promise<void> { await new Promise<void>((resolve) => this.server?.close(() => resolve()) ?? resolve()); }

  getPort(): number | undefined {
    const address = this.server?.address();
    return address && typeof address === "object" ? address.port : undefined;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== "POST" || request.url !== "/mcp") { response.statusCode = 404; response.end(); return; }
    let caller: McpCaller | undefined;
    try { caller = await this.authenticate(request.headers.authorization); }
    catch (error) { writeJson(response, { error: String(error) }, 500); return; }
    if (!caller) { writeJson(response, { error: "MCP_UNAUTHORIZED" }, 401); return; }
    try {
      const body = await readBody(request);
      const rpc = JSON.parse(body) as { id?: string | number; method?: string; params?: Record<string, unknown> };
      const result = await this.dispatch(rpc.method ?? "", rpc.params ?? {}, caller);
      writeJson(response, { jsonrpc: "2.0", id: rpc.id ?? null, result });
    } catch (error) {
      const message = String(error);
      const decision = error && typeof error === "object" && "decision" in error ? (error as { decision?: unknown }).decision : undefined;
      const status = message.includes("ACTION_DENIED") || message.includes("TASK_BINDING_DENIED") ? 403 : message.includes("ACTION_NOT_FOUND") || message.includes("METHOD_NOT_FOUND") ? 404 : 500;
      writeJson(response, { jsonrpc: "2.0", id: null, error: { code: -32000, message, ...(decision ? { data: { decision } } : {}) } }, status);
    }
  }

  private async dispatch(method: string, params: Record<string, unknown>, caller: McpCaller): Promise<JsonValue> {
    if (method === "initialize") return { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "agent-home-gateway", version: "0.1.0" } };
    if (method === "notifications/initialized") return null;
    if (caller.caller === "CONTROL" && (method === "tools/list" || method === "tools/call")) throw new Error("MCP_CONTROL_METHOD_NOT_ALLOWED");
    if (method === "tools/list") return { tools: this.toolDefinitions(caller) as never };
    if (method === "tools/call") {
      const name = typeof params.name === "string" ? params.name : "";
      const args = params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments) ? params.arguments as Record<string, unknown> : {};
      try {
        const value = await this.dispatch(name, args, caller);
        return { content: [{ type: "text", text: JSON.stringify(value) }] };
      } catch (error) {
        return { content: [{ type: "text", text: String(error) }], isError: true };
      }
    }
    if (method === "register_worker_binding") {
      if (caller.caller !== "CONTROL") throw new Error("MCP_CONTROL_REQUIRED");
      const binding = validateWorkerBinding({ taskId: params.taskId, workerId: params.workerId, allowedActions: params.allowedActions });
      const token = typeof params.token === "string" && params.token ? params.token : "";
      if (!token || token === this.token || token === this.controlToken) throw new Error("MCP_WORKER_BINDING_INVALID");
      await this.saveWorkerBinding(token, binding);
      return { registered: true };
    }
    if (method === "unregister_worker_binding") {
      if (caller.caller !== "CONTROL") throw new Error("MCP_CONTROL_REQUIRED");
      const token = typeof params.token === "string" ? params.token : "";
      if (!token) throw new Error("MCP_WORKER_BINDING_INVALID");
      return { removed: await this.removeWorkerBinding(token) };
    }
    if (caller.caller === "CONTROL") throw new Error("MCP_CONTROL_METHOD_NOT_ALLOWED");
    const exposed = caller.caller === "WORKER" ? caller.allowedActions ?? new Set<string>() : this.allowedActions;
    const permissions = caller.caller === "WORKER" ? caller.allowedPermissions ?? new Set<string>() : this.allowedPermissions;
    const isExposed = async (name: string, permission: string) => {
      if (!exposed.has(name) || (permissions.size !== 0 && !permissions.has(permission))) return false;
      return true;
    };
    if (method === "list_actions") return (await this.filterActions(this.actions.list(), isExposed)) as never;
    if (method === "search_actions") {
      const query = String(params.query ?? "").toLowerCase();
      return (await this.filterActions(this.actions.list(), isExposed)).filter((action) => `${action.name} ${action.description}`.toLowerCase().includes(query)) as never;
    }
    if (method === "get_action") {
      const action = this.actions.get(String(params.name ?? ""));
       if (!action || !(await isExposed(action.definition.name, action.definition.permission))) throw new Error("ACTION_NOT_FOUND");
      return action.definition as never;
    }
    if (method === "invoke_action") {
      const action = this.actions.get(String(params.name ?? ""));
      if (!action) throw new Error("ACTION_NOT_FOUND");
       if (!(await isExposed(action.definition.name, action.definition.permission))) { this.audit?.({ operation: "agent_action.invoke", decision: "DENY", reason: "ACTION_DENIED", resource: action.definition.name, requesterId: caller.requesterId, ...(caller.taskId ? { taskId: caller.taskId } : {}) }); throw new Error("ACTION_DENIED"); }
         // The bearer token is the Worker capability. Never derive its Task from RPC input.
         const taskId = caller.caller === "WORKER" ? caller.taskId : undefined;
         if (caller.caller === "WORKER" && !taskId) throw new Error("MCP_TASK_BINDING_DENIED");
         const invocationId = newId("agent-action");
          const context = { invocationId, caller: caller.caller, requesterId: caller.requesterId, ...(taskId ? { taskId } : {}), ...(caller.workerId ? { workerId: caller.workerId } : {}) } as const;
          this.audit?.({ operation: "agent_action.invoke", decision: "ALLOW", resource: action.definition.name, requesterId: caller.requesterId, ...(taskId ? { taskId } : {}) });
         this.logger.info("Agent Action started", { invocationId, action: action.definition.name, caller: caller.caller, requesterId: caller.requesterId, ...(taskId ? { taskId } : {}), ...(caller.workerId ? { workerId: caller.workerId } : {}) });
         let timer: NodeJS.Timeout | undefined;
         try {
           const result = await Promise.race([
             action.handler((params.input ?? null) as JsonValue, context),
             new Promise<never>((_, reject) => { const timeout = setTimeout(() => reject(new Error("AGENT_ACTION_TIMEOUT")), this.actionTimeoutMs); timer = timeout; timeout.unref(); }),
           ]);
           this.logger.info("Agent Action completed", { invocationId, action: action.definition.name });
           return result;
          } catch (error) {
            this.audit?.({ operation: "agent_action.invoke", decision: "DENY", reason: String(error), resource: action.definition.name, requesterId: caller.requesterId, ...(taskId ? { taskId } : {}) });
            this.logger.warn("Agent Action failed", { invocationId, action: action.definition.name, error: String(error) });
           throw error;
         } finally {
           if (timer) clearTimeout(timer);
         }
    }
    throw new Error("METHOD_NOT_FOUND");
  }

  private async filterActions(actions: ReturnType<AgentActionRegistry["list"]>, isExposed: (name: string, permission: string) => Promise<boolean>): Promise<typeof actions> {
    const allowed = await Promise.all(actions.map(async (action) => (await isExposed(action.name, action.permission) ? action : undefined)));
    return allowed.filter((action): action is (typeof actions)[number] => Boolean(action));
  }

  private toolDefinitions(caller: McpCaller): Array<Record<string, unknown>> {
    const exposed = caller.caller === "WORKER" ? caller.allowedActions ?? new Set<string>() : this.allowedActions;
    const hasActions = exposed.size > 0;
    const tools: Array<Record<string, unknown>> = [
      { name: "list_actions", description: "List Gateway Agent Actions available to the authenticated caller.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
      { name: "search_actions", description: "Search Gateway Agent Actions available to the authenticated caller.", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false } },
      { name: "get_action", description: "Get the schema for one Gateway Agent Action available to the authenticated caller.", inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false } },
    ];
    if (hasActions) tools.push({ name: "invoke_action", description: "Invoke one authorized Gateway Agent Action.", inputSchema: { type: "object", properties: { name: { type: "string" }, input: { type: "object" } }, required: ["name"], additionalProperties: false } });
    return tools;
  }

  private async authenticate(header: string | undefined): Promise<McpCaller | undefined> {
    const presented = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
    if (this.controlToken && presented === this.controlToken) return { caller: "CONTROL", requesterId: "mcp:control" };
    if (presented && presented !== this.token) {
      const resolved = this.workerCapabilityResolver ? await this.workerCapabilityResolver(presented) : undefined;
      const binding = resolved ?? this.workerBindings.get(presented);
      if (binding) return { caller: "WORKER", requesterId: `mcp:worker:${binding.taskId}`, taskId: binding.taskId, ...(binding.workerId ? { workerId: binding.workerId } : {}), allowedActions: new Set(binding.allowedActions), allowedPermissions: binding.allowedPermissions ? new Set(binding.allowedPermissions) : undefined };
    }
    if (this.token && presented === this.token) return { caller: "MAIN", requesterId: "mcp:main" };
    return undefined;
  }

  private async saveWorkerBinding(token: string, binding: WorkerBinding): Promise<void> {
    if (!this.workerBindingsPath) {
      this.workerBindings.set(token, binding);
      return;
    }
    const bindings = await this.readWorkerBindingsFile();
    bindings[token] = binding;
    await this.writeWorkerBindingsFile(bindings);
    this.workerBindings.set(token, binding);
  }

  private async removeWorkerBinding(token: string): Promise<boolean> {
    if (!this.workerBindingsPath) return this.workerBindings.delete(token);
    const bindings = await this.readWorkerBindingsFile();
    const existed = Object.prototype.hasOwnProperty.call(bindings, token);
    if (existed) {
      delete bindings[token];
      await this.writeWorkerBindingsFile(bindings);
    }
    this.workerBindings.delete(token);
    return existed;
  }

  private async readWorkerBindingsFile(): Promise<Record<string, WorkerBinding>> {
    if (!this.workerBindingsPath) return Object.fromEntries(this.workerBindings);
    try {
      const value = JSON.parse(await readFile(this.workerBindingsPath, "utf8")) as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("MCP_WORKER_BINDINGS_INVALID");
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([token, binding]) => [token, validateWorkerBinding(binding)]));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  }

  private async writeWorkerBindingsFile(bindings: Record<string, WorkerBinding>): Promise<void> {
    if (!this.workerBindingsPath) return;
    await mkdir(dirname(this.workerBindingsPath), { recursive: true });
    const temporary = `${this.workerBindingsPath}.tmp-${process.pid}`;
    await writeFile(temporary, `${JSON.stringify(bindings)}\n`, { mode: 0o600 });
    await rename(temporary, this.workerBindingsPath);
  }
}

function validateWorkerBinding(value: unknown): WorkerBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("MCP_WORKER_BINDING_INVALID");
  const input = value as Record<string, unknown>;
  if (typeof input.taskId !== "string" || !input.taskId || !Array.isArray(input.allowedActions) || input.allowedActions.some((item) => typeof item !== "string" || !item)) throw new Error("MCP_WORKER_BINDING_INVALID");
  if (input.workerId !== undefined && (typeof input.workerId !== "string" || !input.workerId)) throw new Error("MCP_WORKER_BINDING_INVALID");
  if (input.allowedPermissions !== undefined && (!Array.isArray(input.allowedPermissions) || input.allowedPermissions.some((item) => typeof item !== "string" || !item))) throw new Error("MCP_WORKER_BINDING_INVALID");
  return { taskId: input.taskId, ...(input.workerId ? { workerId: input.workerId } : {}), allowedActions: [...new Set(input.allowedActions as string[])], ...(input.allowedPermissions ? { allowedPermissions: [...new Set(input.allowedPermissions as string[])] } : {}) };
}

async function readBody(request: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of request) { body += String(chunk); if (body.length > 1_000_000) throw new Error("REQUEST_TOO_LARGE"); }
  return body;
}

function writeJson(response: ServerResponse, value: unknown, status = 200): void {
  response.statusCode = status; response.setHeader("content-type", "application/json"); response.end(JSON.stringify(value));
}
