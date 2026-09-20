import type { AppConfig } from "../config.js";
import { Logger } from "../shared/logger.js";
import { QQChatPlatformAdapter } from "../qq/adapter.js";
import { GatewayState } from "./state.js";
import { AgentActionRegistry, CommandRegistry } from "./registry.js";
import { loadPlugins } from "./plugins.js";
import { Router } from "./router.js";
import { PodmanController } from "../controller.js";
import { GatewayMcpServer } from "./mcp.js";

export class GatewayApp {
  private readonly state: GatewayState;
  private readonly adapter: QQChatPlatformAdapter;
  private readonly controller: PodmanController;
  private readonly commands = new CommandRegistry();
  private readonly actions = new AgentActionRegistry();
  private readonly mcp: GatewayMcpServer;
  private readonly log: Logger;

  private readonly config: AppConfig;
  constructor(config: AppConfig, logger: Logger) {
    this.config = config;
    this.log = logger.child("gateway");
    this.state = new GatewayState(config.paths.gatewayState);
    this.adapter = new QQChatPlatformAdapter(config, this.log);
    this.controller = new PodmanController(config, this.state, this.log);
    this.mcp = new GatewayMcpServer(this.actions, Number(process.env.GATEWAY_MCP_PORT ?? 8787), this.log);
  }

  async start(): Promise<void> {
    await loadPlugins(this.config, this.commands, this.actions, this.log);
    await this.controller.start();
    await this.mcp.start();
    await this.adapter.start((event) => this.router.handle(event));
    this.log.info("Bot Gateway ready", { platform: this.adapter.platform });
  }

  async stop(): Promise<void> {
    await this.adapter.stop(); await this.mcp.stop(); await this.controller.stop(); this.state.close();
  }

  private get router(): Router {
    return this._router ??= new Router(this.config, this.adapter, this.state, this.commands, this.actions, this.controller, this.log);
  }
  private _router: Router | undefined;
}
