import type { JsonValue } from "../shared/types.js";

export interface McpActionClientOptions {
  endpoint: string;
  token: string;
  caller: "MAIN" | "WORKER" | "CONTROL";
  timeoutMs?: number;
}

export interface WorkerMcpBinding {
  token: string;
  taskId: string;
  workerId: string;
  allowedActions: string[];
  allowedPermissions?: string[];
}

export interface McpActionDefinition {
  name: string;
  description: string;
  inputSchema: JsonValue;
  permission: string;
  pluginId: string;
}

export class GatewayMcpClient {
  private readonly options: McpActionClientOptions;
  private nextId = 0;
  private initialized = false;
  private initializePromise: Promise<void> | undefined;

  constructor(options: McpActionClientOptions) {
    this.options = options;
  }

  listActions(): Promise<McpActionDefinition[]> { return this.callTool("list_actions", {}); }

  searchActions(query: string): Promise<McpActionDefinition[]> { return this.callTool("search_actions", { query }); }

  getAction(name: string): Promise<McpActionDefinition> { return this.callTool("get_action", { name }); }

  invokeAction(name: string, input: JsonValue): Promise<JsonValue> {
    return this.callTool("invoke_action", { name, input });
  }

  registerWorkerBinding(binding: WorkerMcpBinding): Promise<{ registered: true }> {
    if (this.options.caller !== "CONTROL") throw new Error("MCP_CONTROL_REQUIRED");
    return this.request("register_worker_binding", { token: binding.token, taskId: binding.taskId, workerId: binding.workerId, allowedActions: binding.allowedActions, ...(binding.allowedPermissions !== undefined ? { allowedPermissions: binding.allowedPermissions } : {}) });
  }

  unregisterWorkerBinding(token: string): Promise<{ removed: boolean }> {
    if (this.options.caller !== "CONTROL") throw new Error("MCP_CONTROL_REQUIRED");
    return this.request("unregister_worker_binding", { token });
  }

  private async request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    if (method !== "initialize" && !this.initialized) await this.initialize();
    return this.requestRaw<T>(method, params);
  }

  private async initialize(): Promise<void> {
    if (this.initialized) return;
    if (!this.initializePromise) {
      this.initializePromise = this.requestRaw("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "agent-home-gateway-client", version: "0.1.0" },
      }).then(async () => {
        await this.requestRaw("notifications/initialized", {}, true);
        this.initialized = true;
      }).catch((error) => {
        this.initializePromise = undefined;
        throw error;
      });
    }
    await this.initializePromise;
  }

  private async requestRaw<T>(method: string, params: Record<string, unknown>, notification = false): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 10000);
    try {
      const response = await fetch(this.options.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.options.token}` },
        body: JSON.stringify({ jsonrpc: "2.0", ...(notification ? {} : { id: ++this.nextId }), method, params }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`MCP_REQUEST_FAILED:${response.status}`);
      if (notification) return undefined as T;
      const body = await response.json() as { result?: T; error?: { message?: string } };
      if (body.error) throw new Error(`MCP_REQUEST_FAILED:${body.error.message ?? response.status}`);
      return body.result as T;
    } finally {
      clearTimeout(timer);
    }
  }

  private async callTool<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const result = await this.request<{ content?: Array<{ type?: string; text?: string }>; isError?: boolean }>("tools/call", { name, arguments: args });
    const text = result.content?.filter((item) => item.type === "text" && typeof item.text === "string").map((item) => item.text as string).join("\n") ?? "";
    if (result.isError) throw new Error(text || `MCP_TOOL_FAILED:${name}`);
    if (!text) return result as T;
    try { return JSON.parse(text) as T; } catch { return text as T; }
  }
}
