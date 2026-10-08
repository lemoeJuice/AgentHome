import type { JsonValue } from "../shared/types.js";

export interface CommandContext {
  invocationId: string;
  requester: { platform: string; accountId: string; userId: string; principalId?: string };
  conversation: { conversationId: string; kind: "private" | "group"; platformConversationId: string; threadId: JsonValue };
  message: { messageId: string; replyTo: JsonValue; text: string };
  signal: AbortSignal;
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
  readonly signal: AbortSignal;
  onDispose(cleanup: () => void | Promise<void>): void;
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

export interface PluginLifecycleHandle { stop(): Promise<void> }

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
  signal?: AbortSignal;
  taskId?: string;
  workerId?: string;
}

export type AgentActionHandler = (input: JsonValue, context: AgentActionContext) => Promise<JsonValue>;

export class CommandRegistry {
  private readonly commands = new Map<string, { definition: CommandDefinition; handler: CommandHandler; pluginState?: PluginStateHandle }>();
  private readonly pluginLifecycles = new Set<PluginLifecycleHandle>();

  register(definition: CommandDefinition, handler: CommandHandler, pluginState?: PluginStateHandle): void {
    const names = [definition.name, ...(definition.aliases ?? [])];
    for (const name of names) {
      if (this.commands.has(name)) throw new Error(`COMMAND_COLLISION:${name}`);
      this.commands.set(name, { definition, handler, ...(pluginState ? { pluginState } : {}) });
    }
  }

  assertCanMerge(other: CommandRegistry): void {
    for (const name of other.commands.keys()) if (this.commands.has(name)) throw new Error(`COMMAND_COLLISION:${name}`);
  }

  merge(other: CommandRegistry): void {
    this.assertCanMerge(other);
    for (const [name, route] of other.commands) this.commands.set(name, route);
    for (const lifecycle of other.pluginLifecycles) this.pluginLifecycles.add(lifecycle);
  }

  registerPluginLifecycle(lifecycle: PluginLifecycleHandle): void { this.pluginLifecycles.add(lifecycle); }
  async stopPlugins(): Promise<void> { await Promise.allSettled([...this.pluginLifecycles].map((lifecycle) => lifecycle.stop())); }
  async removePlugins(): Promise<void> {
    await this.stopPlugins();
    for (const [name, route] of this.commands) if (route.definition.kind === "PLUGIN") this.commands.delete(name);
    this.pluginLifecycles.clear();
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

  assertCanMerge(other: AgentActionRegistry): void {
    for (const name of other.actions.keys()) if (this.actions.has(name)) throw new Error(`ACTION_COLLISION:${name}`);
  }

  merge(other: AgentActionRegistry): void {
    this.assertCanMerge(other);
    for (const [name, action] of other.actions) this.actions.set(name, action);
  }

  list(): AgentActionDefinition[] { return [...this.actions.values()].map((item) => item.definition); }
  removePlugins(): void { this.actions.clear(); }
  get(name: string): { definition: AgentActionDefinition; handler: AgentActionHandler } | undefined { return this.actions.get(name); }
}
