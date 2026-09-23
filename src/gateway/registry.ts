import type { JsonValue } from "../shared/types.js";

export interface CommandContext {
  invocationId: string;
  requester: { platform: string; accountId: string; userId: string; principalId?: string };
  conversation: { conversationId: string; kind: "private" | "group"; platformConversationId: string; threadId: JsonValue };
  message: { messageId: string; replyTo: JsonValue };
  args: string[];
  rawArgs: string;
  pluginState: PluginStateHandle;
}

export interface CommandResult {
  text?: string;
  artifacts?: Array<{ ref: { authority: "agent-home" | "bot-gateway"; artifactId: string }; filename: string; mime?: string; size: number; path?: string }>;
  context?: { type: string; summary: string; resultRef?: string };
}

export interface PluginStateHandle {
  readonly root: string;
  readJson<T>(name: string): Promise<T | null>;
  writeJson(name: string, value: JsonValue): Promise<void>;
}

export interface PluginContext {
  readonly pluginId: string;
  readonly state: PluginStateHandle;
  registerCommand(definition: CommandDefinition, handler: CommandHandler): void;
  registerAgentAction(definition: AgentActionDefinition, handler: AgentActionHandler): void;
}

export interface CommandDefinition {
  name: string;
  aliases?: string[];
  permission: string;
  pluginId?: string;
  kind: "CORE" | "PLUGIN";
}

export type CommandHandler = (context: CommandContext) => Promise<CommandResult>;

export interface AgentActionDefinition {
  name: string;
  description: string;
  inputSchema: JsonValue;
  permission: string;
  pluginId: string;
}

export interface AgentActionContext {
  invocationId: string;
  caller: "MAIN" | "WORKER";
  requesterId: string;
  taskId?: string;
  workerId?: string;
}

export type AgentActionHandler = (input: JsonValue, context: AgentActionContext) => Promise<JsonValue>;

export class CommandRegistry {
  private readonly commands = new Map<string, { definition: CommandDefinition; handler: CommandHandler; pluginState?: PluginStateHandle }>();

  register(definition: CommandDefinition, handler: CommandHandler, pluginState?: PluginStateHandle): void {
    const names = [definition.name, ...(definition.aliases ?? [])];
    for (const name of names) {
      if (this.commands.has(name)) throw new Error(`COMMAND_COLLISION:${name}`);
      this.commands.set(name, { definition, handler, ...(pluginState ? { pluginState } : {}) });
    }
  }

  resolve(name: string): { definition: CommandDefinition; handler: CommandHandler; pluginState?: PluginStateHandle } | undefined { return this.commands.get(name); }
  list(): CommandDefinition[] { return [...new Set([...this.commands.values()].map((item) => item.definition))]; }
}

export class AgentActionRegistry {
  private readonly actions = new Map<string, { definition: AgentActionDefinition; handler: AgentActionHandler }>();

  register(definition: AgentActionDefinition, handler: AgentActionHandler): void {
    if (this.actions.has(definition.name)) throw new Error(`ACTION_COLLISION:${definition.name}`);
    this.actions.set(definition.name, { definition, handler });
  }

  list(): AgentActionDefinition[] { return [...this.actions.values()].map((item) => item.definition); }
  get(name: string): { definition: AgentActionDefinition; handler: AgentActionHandler } | undefined { return this.actions.get(name); }
}
