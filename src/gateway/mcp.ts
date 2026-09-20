import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AgentActionRegistry } from "./registry.js";
import type { Logger } from "../shared/logger.js";
import type { JsonValue } from "../shared/types.js";

export class GatewayMcpServer {
  private server: Server | undefined;
  private readonly actions: AgentActionRegistry;
  private readonly port: number;
  private readonly logger: Logger;
  private readonly host: string;
  private readonly token: string | undefined;
  private readonly allowedActions: Set<string>;
  private readonly workerToken: string | undefined;
  private readonly workerTaskId: string | undefined;
  constructor(actions: AgentActionRegistry, port: number, logger: Logger, options: { host?: string; token?: string; workerToken?: string; workerTaskId?: string; allowedActions?: string[] } = {}) {
    this.actions = actions; this.port = port; this.logger = logger; this.host = options.host ?? "127.0.0.1"; this.token = options.token; this.workerToken = options.workerToken; this.workerTaskId = options.workerTaskId; this.allowedActions = new Set(options.allowedActions ?? []);
  }

  async start(): Promise<void> {
    if (this.host !== "127.0.0.1" && this.host !== "::1" && !this.token && !this.workerToken) throw new Error("MCP_TOKEN_REQUIRED_FOR_NON_LOOPBACK");
    if (this.allowedActions.size > 0 && !this.token && !this.workerToken) throw new Error("MCP_TOKEN_REQUIRED_WHEN_ACTIONS_EXPOSED");
    this.server = createServer((request, response) => { void this.handle(request, response); });
    await new Promise<void>((resolve, reject) => { this.server?.once("error", reject); this.server?.listen(this.port, this.host, resolve); });
    this.logger.info("Gateway MCP ready", { host: this.host, port: this.port, exposedActions: [...this.allowedActions] });
  }

  async stop(): Promise<void> { await new Promise<void>((resolve) => this.server?.close(() => resolve()) ?? resolve()); }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== "POST" || request.url !== "/mcp") { response.statusCode = 404; response.end(); return; }
    const caller = this.authenticate(request.headers.authorization);
    if (!caller) { writeJson(response, { error: "MCP_UNAUTHORIZED" }, 401); return; }
    try {
      const body = await readBody(request);
      const rpc = JSON.parse(body) as { id?: string | number; method?: string; params?: Record<string, unknown> };
      const result = await this.dispatch(rpc.method ?? "", rpc.params ?? {}, caller);
      writeJson(response, { jsonrpc: "2.0", id: rpc.id ?? null, result });
    } catch (error) { writeJson(response, { jsonrpc: "2.0", id: null, error: { code: -32000, message: String(error) } }, 500); }
  }

  private async dispatch(method: string, params: Record<string, unknown>, caller: { caller: "MAIN" | "WORKER"; requesterId: string }): Promise<JsonValue> {
    if (method === "list_actions") return this.actions.list().filter((action) => this.allowedActions.has(action.name)) as never;
    if (method === "search_actions") {
      const query = String(params.query ?? "").toLowerCase();
      return this.actions.list().filter((action) => this.allowedActions.has(action.name) && `${action.name} ${action.description}`.toLowerCase().includes(query)) as never;
    }
    if (method === "get_action") {
      const action = this.actions.get(String(params.name ?? ""));
      if (!action || !this.allowedActions.has(action.definition.name)) throw new Error("ACTION_NOT_FOUND");
      return action.definition as never;
    }
    if (method === "invoke_action") {
      const action = this.actions.get(String(params.name ?? ""));
      if (!action) throw new Error("ACTION_NOT_FOUND");
       if (!this.allowedActions.has(action.definition.name)) throw new Error("ACTION_DENIED");
       const taskId = caller.caller === "WORKER" && this.workerTaskId && params.taskId === this.workerTaskId ? this.workerTaskId : undefined;
       return await action.handler((params.input ?? null) as JsonValue, { caller: caller.caller, requesterId: caller.requesterId, ...(taskId ? { taskId } : {}) });
    }
    throw new Error("METHOD_NOT_FOUND");
  }

  private authenticate(header: string | undefined): { caller: "MAIN" | "WORKER"; requesterId: string } | undefined {
    const presented = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
    if (this.workerToken && presented === this.workerToken) return { caller: "WORKER", requesterId: "mcp:worker" };
    if (this.token && presented === this.token) return { caller: "MAIN", requesterId: "mcp:main" };
    if (!this.token && !this.workerToken && this.allowedActions.size === 0) return { caller: "MAIN", requesterId: "mcp:none" };
    return undefined;
  }
}

async function readBody(request: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of request) { body += String(chunk); if (body.length > 1_000_000) throw new Error("REQUEST_TOO_LARGE"); }
  return body;
}

function writeJson(response: ServerResponse, value: unknown, status = 200): void {
  response.statusCode = status; response.setHeader("content-type", "application/json"); response.end(JSON.stringify(value));
}
