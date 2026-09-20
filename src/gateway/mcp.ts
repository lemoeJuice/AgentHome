import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AgentActionRegistry } from "./registry.js";
import type { Logger } from "../shared/logger.js";
import type { JsonValue } from "../shared/types.js";

export class GatewayMcpServer {
  private server: Server | undefined;
  private readonly actions: AgentActionRegistry;
  private readonly port: number;
  private readonly logger: Logger;
  constructor(actions: AgentActionRegistry, port: number, logger: Logger) { this.actions = actions; this.port = port; this.logger = logger; }

  async start(): Promise<void> {
    this.server = createServer((request, response) => { void this.handle(request, response); });
    await new Promise<void>((resolve, reject) => { this.server?.once("error", reject); this.server?.listen(this.port, "127.0.0.1", resolve); });
    this.logger.info("Gateway MCP ready", { port: this.port });
  }

  async stop(): Promise<void> { await new Promise<void>((resolve) => this.server?.close(() => resolve()) ?? resolve()); }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== "POST" || request.url !== "/mcp") { response.statusCode = 404; response.end(); return; }
    try {
      const body = await readBody(request);
      const rpc = JSON.parse(body) as { id?: string | number; method?: string; params?: Record<string, unknown> };
      const result = await this.dispatch(rpc.method ?? "", rpc.params ?? {});
      writeJson(response, { jsonrpc: "2.0", id: rpc.id ?? null, result });
    } catch (error) { writeJson(response, { jsonrpc: "2.0", id: null, error: { code: -32000, message: String(error) } }, 500); }
  }

  private async dispatch(method: string, params: Record<string, unknown>): Promise<JsonValue> {
    if (method === "list_actions") return this.actions.list() as never;
    if (method === "search_actions") {
      const query = String(params.query ?? "").toLowerCase();
      return this.actions.list().filter((action) => `${action.name} ${action.description}`.toLowerCase().includes(query)) as never;
    }
    if (method === "get_action") {
      const action = this.actions.get(String(params.name ?? ""));
      if (!action) throw new Error("ACTION_NOT_FOUND");
      return action.definition as never;
    }
    if (method === "invoke_action") {
      const action = this.actions.get(String(params.name ?? ""));
      if (!action) throw new Error("ACTION_NOT_FOUND");
      const authorization = params.authorization as { allowedActions?: string[] } | undefined;
      if (!authorization?.allowedActions?.includes(action.definition.name)) throw new Error("ACTION_DENIED");
      const caller = params.caller === "WORKER" ? "WORKER" : "MAIN";
      return await action.handler((params.input ?? null) as JsonValue, { caller, requesterId: String(params.requesterId ?? "unknown"), ...(params.taskId ? { taskId: String(params.taskId) } : {}) });
    }
    throw new Error("METHOD_NOT_FOUND");
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
