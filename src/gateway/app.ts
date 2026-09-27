import { existsSync, readFileSync } from "node:fs";
import type { AppConfig } from "../config.js";
import { Logger } from "../shared/logger.js";
import { QQChatPlatformAdapter } from "../qq/adapter.js";
import { GatewayState } from "./state.js";
import { AgentActionRegistry, CommandRegistry } from "./registry.js";
import { loadPlugins } from "./plugins.js";
import { Router } from "./router.js";
import { PodmanController } from "../controller.js";
import { GatewayMcpServer, JsonFileMcpWorkerCapabilityResolver, type WorkerBinding } from "./mcp.js";
import { GatewayArtifactService } from "./artifacts.js";
import { createPiModelCommand } from "./pi-model-command.js";
import { newId, nowIso } from "../shared/ids.js";

export class GatewayApp {
  private readonly state: GatewayState;
  private readonly adapter: QQChatPlatformAdapter;
  private readonly controller: PodmanController;
  private readonly commands = new CommandRegistry();
  private readonly actions = new AgentActionRegistry();
  private readonly mcp: GatewayMcpServer;
  private readonly artifacts: GatewayArtifactService;
  private readonly log: Logger;
  private artifactMaintenance: NodeJS.Timeout | undefined;

  private readonly config: AppConfig;
  constructor(config: AppConfig, logger: Logger) {
    this.config = config;
    this.log = logger.child("gateway");
    this.state = new GatewayState(config.paths.gatewayState);
    this.adapter = new QQChatPlatformAdapter(config, this.log);
    this.controller = new PodmanController(config, this.state, this.log);
    this.artifacts = new GatewayArtifactService(this.state.store, config.paths.gatewayState, this.log);
    const mcpToken = process.env.GATEWAY_MCP_TOKEN ?? readSecret(".agent-home/mcp-main-token");
    const mcpControlToken = process.env.GATEWAY_MCP_CONTROL_TOKEN ?? readSecret(".agent-home/mcp-control-token");
    const workerBindingsPath = process.env.GATEWAY_MCP_WORKER_BINDINGS_FILE ?? ".agent-home/mcp-worker-bindings.json";
    const fileResolver = existsSync(workerBindingsPath) ? new JsonFileMcpWorkerCapabilityResolver(workerBindingsPath) : undefined;
    const workerCapabilityResolver = fileResolver?.resolve.bind(fileResolver);
    const allowedActions = process.env.GATEWAY_MCP_ALLOWED_ACTIONS === undefined ? (config.plugins.allowedActions ?? []) : process.env.GATEWAY_MCP_ALLOWED_ACTIONS.split(",").map((item) => item.trim()).filter(Boolean);
    const allowedPermissions = process.env.GATEWAY_MCP_ALLOWED_PERMISSIONS === undefined ? config.plugins.allowedPermissions : process.env.GATEWAY_MCP_ALLOWED_PERMISSIONS.split(",").map((item) => item.trim()).filter(Boolean);
     this.mcp = new GatewayMcpServer(this.actions, config.gateway.mcpPort, this.log, { host: config.gateway.mcpHost ?? (mcpToken ? "0.0.0.0" : "127.0.0.1"), token: mcpToken, controlToken: mcpControlToken, workerBindingsPath, ...(workerCapabilityResolver ? { workerCapabilityResolver } : { workerBindings: readWorkerBindings() }), allowedActions, ...(allowedPermissions !== undefined ? { allowedPermissions } : {}), actionTimeoutMs: config.gateway.mcpActionTimeoutMs, audit: (event) => this.state.store.run("INSERT INTO authorization_audit_events(id,operation,decision,reason,resource,requester_id,task_id,metadata_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)", newId("authz"), event.operation, event.decision, event.reason ?? null, event.resource, event.requesterId ?? null, event.taskId ?? null, null, nowIso()) });
  }

  async start(): Promise<void> {
    this.commands.register({ name: "model", aliases: ["models"], permission: "admin", pluginId: "core.pi-model", kind: "CORE" }, createPiModelCommand(this.config, this.log));
    await loadPlugins(this.config, this.commands, this.actions, this.log);
    await this.controller.start();
    await this.artifacts.start();
    this.artifactMaintenance = setInterval(() => { void Promise.all([this.artifacts.cleanupExpired(), Promise.resolve(this.state.cleanupOperationalState())]).catch((error) => this.log.warn("Gateway maintenance failed", { error: String(error) })); }, 60_000).unref();
    await this.mcp.start();
    await this.router.replayPendingOutbound();
    await this.adapter.start((event) => this.router.handle(event));
    this.log.info("Bot Gateway ready", { platform: this.adapter.platform });
  }

  async stop(): Promise<void> {
    await this.adapter.stop(); await this.mcp.stop(); if (this.artifactMaintenance) clearInterval(this.artifactMaintenance); await this.artifacts.stop(); await this.controller.stop(); this.state.close();
  }

  private get router(): Router {
    return this._router ??= new Router(this.config, this.adapter, this.state, this.commands, this.actions, this.controller, this.log, this.artifacts);
  }
  private _router: Router | undefined;
}

function readSecret(path: string): string | undefined {
  try { const value = readFileSync(path, "utf8").trim(); return value || undefined; } catch { return undefined; }
}

function readWorkerBindings(): Record<string, WorkerBinding> | undefined {
  const raw = process.env.GATEWAY_MCP_WORKER_BINDINGS;
  if (!raw) return undefined;
  const value = JSON.parse(raw) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("MCP_WORKER_BINDINGS_INVALID");
  const result: Record<string, WorkerBinding> = {};
  for (const [token, binding] of Object.entries(value)) {
    if (!token || !binding || typeof binding !== "object" || Array.isArray(binding)) throw new Error("MCP_WORKER_BINDINGS_INVALID");
    const item = binding as Record<string, unknown>;
    if (typeof item.taskId !== "string" || !item.taskId) throw new Error("MCP_WORKER_BINDINGS_INVALID");
    const readList = (field: string, required = false): string[] | undefined => {
      if (item[field] === undefined) { if (required) throw new Error("MCP_WORKER_BINDINGS_INVALID"); return undefined; }
      if (!Array.isArray(item[field]) || item[field].some((entry) => typeof entry !== "string" || !entry)) throw new Error("MCP_WORKER_BINDINGS_INVALID");
      return [...new Set(item[field] as string[])];
    };
    const allowedActions = readList("allowedActions", true) as string[];
    const allowedPermissions = readList("allowedPermissions");
    if (item.workerId !== undefined && (typeof item.workerId !== "string" || !item.workerId)) throw new Error("MCP_WORKER_BINDINGS_INVALID");
    result[token] = { taskId: item.taskId, ...(item.workerId ? { workerId: item.workerId } : {}), allowedActions, ...(allowedPermissions ? { allowedPermissions } : {}) };
  }
  return result;
}
