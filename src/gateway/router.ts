import type { AppConfig } from "../config.js";
import { newId, nowIso, messageKey, conversationKey } from "../shared/ids.js";
import type { ChatEvent, ChatPlatformAdapter, ControllerEventEnvelope, ConversationAddress, JsonValue, PlatformMessageRef } from "../shared/types.js";
import type { Logger } from "../shared/logger.js";
import { GatewayState } from "./state.js";
import { CommandRegistry, type CommandContext, type CommandResult, AgentActionRegistry } from "./registry.js";

function commandAllowed(permission: string, event: ChatEvent, owner: AppConfig["owner"]): boolean {
  if (!permission) return false;
  if (permission === "owner" || permission === "admin" || permission.startsWith("owner.")) {
    return event.sender.platform === owner.platform && event.sender.accountId === owner.accountId && event.sender.userId === owner.userId;
  }
  return permission === "user" || permission === "public" || permission.startsWith("command.");
}

export interface AgentEventController {
  deliver(event: ControllerEventEnvelope): Promise<void>;
}

const coreCommands = new Set(["status", "tasks", "stop", "new", "usage", "help"]);

export class Router {
  private readonly config: AppConfig;
  private readonly adapter: ChatPlatformAdapter;
  private readonly state: GatewayState;
  private readonly commands: CommandRegistry;
  private readonly actions: AgentActionRegistry;
  private readonly controller: AgentEventController;
  private readonly log: Logger;
  constructor(
    config: AppConfig,
    adapter: ChatPlatformAdapter,
    state: GatewayState,
    commands: CommandRegistry,
    actions: AgentActionRegistry,
    controller: AgentEventController,
    logger: Logger,
  ) { this.config = config; this.adapter = adapter; this.state = state; this.commands = commands; this.actions = actions; this.controller = controller; this.log = logger.child("router"); }

  async handle(event: ChatEvent): Promise<void> {
    const text = event.message.text?.trim() ?? "";
    const conversationId = conversationKey(event.conversation.platform, event.conversation.accountId, event.conversation.platformConversationId, event.conversation.threadId);
    const replyBinding = event.message.replyTo && event.message.replyTo !== null && "messageId" in event.message.replyTo
      ? this.lookupBinding(event.message.replyTo as PlatformMessageRef)
      : undefined;
    const command = this.parseCommand(text);
    if (command) {
      if (!this.commandWakes(event)) return;
      await this.handleCommand(event, conversationId, command.name, command.args);
      return;
    }
    if (event.conversation.kind === "group" && !this.naturalWakes(event)) return;
    await this.controller.deliver(this.toEnvelope(event, conversationId, replyBinding ? { type: "direct_command_result", ...replyBinding } : undefined));
  }

  private async handleCommand(event: ChatEvent, conversationId: string, name: string, args: string[]): Promise<void> {
    if (coreCommands.has(name)) {
      await this.controller.deliver(this.toEnvelope(event, conversationId, { type: "control_command", command: name, args }));
      return;
    }
    const route = this.commands.resolve(name);
    if (!route) {
      await this.adapter.sendMessage(event.conversation, { text: `未知命令 /${name}。发送 /help 查看可用命令。`, replyTo: event.message.ref });
      return;
    }
    if (!commandAllowed(route.definition.permission, event, this.config.owner)) {
      await this.adapter.sendMessage(event.conversation, { text: "当前身份没有执行此命令的权限。", replyTo: event.message.ref });
      return;
    }
    const invocationId = newId("cmd");
    const pluginId = route.definition.pluginId ?? "unknown";
    this.state.store.transaction(() => {
      this.state.store.run("INSERT INTO command_invocations(id,command,plugin_id,requester_id,conversation_id,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)", invocationId, name, pluginId, event.sender.userId, conversationId, "RUNNING", nowIso(), nowIso());
    });
    let result: CommandResult;
    try {
      const context: CommandContext = {
        invocationId,
        requester: event.sender,
        conversation: { conversationId, kind: event.conversation.kind, platformConversationId: event.conversation.platformConversationId, threadId: event.conversation.threadId as JsonValue },
        message: { messageId: event.message.ref.messageId, replyTo: (event.message.replyTo ?? null) as JsonValue },
        args,
        rawArgs: args.join(" "),
        pluginState: route.pluginState ?? { root: "", readJson: async () => null, writeJson: async () => undefined },
      };
      let timeout: NodeJS.Timeout | undefined;
      try {
        result = await Promise.race([route.handler(context), new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("PLUGIN_TIMEOUT")), 30000); })]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
      this.state.store.run("UPDATE command_invocations SET status='COMPLETED',result_json=?,context_summary=?,updated_at=? WHERE id=?", JSON.stringify(result), result.context?.summary ?? null, nowIso(), invocationId);
    } catch (error) {
      this.state.store.run("UPDATE command_invocations SET status='FAILED',context_summary=?,updated_at=? WHERE id=?", String(error), nowIso(), invocationId);
      this.log.error("Direct command failed", { invocationId, command: name, error: String(error) });
      result = { text: "命令执行失败，错误已记录。" };
    }
    const sent = await this.adapter.sendMessage(event.conversation, { text: result.text, replyTo: event.message.ref, attachments: result.artifacts?.map((artifact) => ({ type: artifact.mime?.startsWith("image/") ? "image" : "file", url: artifact.url, filename: artifact.filename })) });
    this.state.store.transaction(() => {
      this.state.store.run("INSERT INTO gateway_message_bindings(id,platform,account_id,platform_conversation_id,thread_id_json,message_id,invocation_id,created_at) VALUES (?,?,?,?,?,?,?,?)", newId("binding"), sent.message.platform, sent.message.accountId, sent.message.platformConversationId, JSON.stringify(sent.message.threadId), sent.message.messageId, invocationId, nowIso());
      this.state.store.run("INSERT INTO recent_interactions(id,conversation_id,invocation_id,summary,result_ref,created_at) VALUES (?,?,?,?,?,?)", newId("recent"), conversationId, invocationId, result.context?.summary ?? result.text ?? "", result.context?.resultRef ?? null, nowIso());
    });
  }

  private commandWakes(event: ChatEvent): boolean {
    return event.conversation.kind !== "group" || !this.policy(event).commandRequireMention || event.message.mentionsBot === true;
  }

  private naturalWakes(event: ChatEvent): boolean {
    const policy = this.policy(event);
    return policy.naturalLanguageMode === "observe_all" || event.message.mentionsBot === true || (event.message.replyTo !== null && event.message.replyTo !== undefined && event.message.replyTo !== (undefined as never));
  }

  private policy(event: ChatEvent): { commandRequireMention: boolean; naturalLanguageMode: "observe_all" | "explicit_wake" } {
    const base = event.platform === "qq" ? this.config.chat.qq : this.config.chat.global;
    const override = this.config.chat.conversationOverrides[event.conversation.platformConversationId];
    return { ...base, ...override };
  }

  private parseCommand(text: string): { name: string; args: string[] } | null {
    if (!text.startsWith("/")) return null;
    const parts = text.slice(1).trim().split(/\s+/).filter(Boolean);
    if (!parts[0]) return null;
    return { name: parts[0].toLowerCase(), args: parts.slice(1) };
  }

  private lookupBinding(ref: PlatformMessageRef): { invocationId: string; command: string; pluginId: string; contextSummary: string; resultRef?: string } | undefined {
    const binding = this.state.store.get<{ invocation_id: string }>("SELECT invocation_id FROM gateway_message_bindings WHERE platform=? AND account_id=? AND platform_conversation_id=? AND thread_id_json=? AND message_id=?", ref.platform, ref.accountId, ref.platformConversationId, JSON.stringify(ref.threadId), ref.messageId);
    if (!binding) return undefined;
    const invocation = this.state.store.get<{ id: string; command: string; plugin_id: string; context_summary: string | null; result_json: string | null }>("SELECT id,command,plugin_id,context_summary,result_json FROM command_invocations WHERE id=?", binding.invocation_id);
    if (!invocation) return undefined;
    let resultRef: string | undefined;
    if (invocation.result_json) resultRef = (JSON.parse(invocation.result_json) as CommandResult).context?.resultRef;
    return { invocationId: invocation.id, command: invocation.command, pluginId: invocation.plugin_id, contextSummary: invocation.context_summary ?? "", ...(resultRef ? { resultRef } : {}) };
  }

  private toEnvelope(event: ChatEvent, conversationKeyValue: string, extra?: Record<string, unknown>): ControllerEventEnvelope {
    return {
      protocolVersion: 1,
      eventId: newId("evt"),
      instanceId: this.config.instanceId,
      type: extra?.type === "control_command" ? "control.command" : "chat.message",
      occurredAt: event.timestamp,
      source: { platform: event.platform, accountId: event.accountId, adapter: "QQChatPlatformAdapter" },
      trustedIdentity: { userId: event.sender.userId },
      conversation: { conversationId: conversationKeyValue, address: event.conversation },
      message: { ref: event.message.ref, replyTo: event.message.replyTo },
      payload: { text: event.message.text, attachments: event.message.attachments, rawSegments: event.message.rawSegments ?? [], ...(extra ?? {}) } as never,
    };
  }
}
