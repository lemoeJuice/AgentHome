import type { AppConfig } from "../config.js";
import { newId, nowIso, messageKey, conversationKey } from "../shared/ids.js";
import type { ChatEvent, ChatPlatformAdapter, ControllerEventEnvelope, ConversationAddress, JsonValue, OutgoingMessage, PlatformMessageRef, SendResult } from "../shared/types.js";
import type { Logger } from "../shared/logger.js";
import { GatewayState } from "./state.js";
import { CommandRegistry, type CommandContext, type CommandResult, AgentActionRegistry } from "./registry.js";
import { GatewayArtifactService } from "./artifacts.js";

function commandAllowed(permission: string, event: ChatEvent, owner: AppConfig["owner"]): boolean {
  if (!permission) return false;
  if (permission === "owner" || permission === "admin" || permission.startsWith("owner.")) {
    return Boolean(owner && event.sender.platform === owner.platform && event.sender.accountId === owner.accountId && event.sender.userId === owner.userId);
  }
  return permission === "user" || permission === "public" || permission.startsWith("command.");
}

export interface AgentEventController {
  deliver(event: ControllerEventEnvelope): Promise<void>;
}

const coreCommands = new Set(["status", "tasks", "stop", "new", "usage", "help", "bind", "unbind"]);

export class Router {
  private readonly config: AppConfig;
  private readonly adapter: ChatPlatformAdapter;
  private readonly state: GatewayState;
  private readonly commands: CommandRegistry;
  private readonly actions: AgentActionRegistry;
  private readonly artifacts: GatewayArtifactService;
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
    artifacts = new GatewayArtifactService(state.store, config.paths.gatewayState, logger),
  ) { this.config = config; this.adapter = adapter; this.state = state; this.commands = commands; this.actions = actions; this.artifacts = artifacts; this.controller = controller; this.log = logger.child("router"); }

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
    await this.controller.deliver(this.toEnvelope(event, conversationId, replyBinding ? { type: "direct_command_result", externalContext: replyBinding } : undefined));
  }

  async replayPendingOutbound(): Promise<void> {
    const intents = this.state.store.all<{ id: string }>("SELECT id FROM gateway_outbound_intents WHERE status='PENDING' ORDER BY created_at");
    for (const intent of intents) await this.deliverIntent(intent.id);
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
      this.audit("command.execute", "DENY", "COMMAND_PERMISSION_DENIED", name, event.sender.userId, conversationId);
      await this.adapter.sendMessage(event.conversation, { text: "当前身份没有执行此命令的权限。", replyTo: event.message.ref });
      return;
    }
    const invocationId = newId("cmd");
    const pluginId = route.definition.pluginId ?? "unknown";
    this.state.store.transaction(() => {
      this.state.store.run("INSERT INTO command_invocations(id,command,plugin_id,requester_id,conversation_id,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)", invocationId, name, pluginId, event.sender.userId, conversationId, "RUNNING", nowIso(), nowIso());
    });
    this.audit("command.execute", "ALLOW", undefined, name, event.sender.userId, conversationId);
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
       result = await this.admitArtifacts(result, route.pluginState?.root ?? "", event, conversationId, invocationId, pluginId);
      this.state.store.transaction(() => {
        this.state.store.run("UPDATE command_invocations SET status='COMPLETED',result_json=?,context_summary=?,updated_at=? WHERE id=?", JSON.stringify(result), result.context?.summary ?? null, nowIso(), invocationId);
        const message: OutgoingMessage = { text: result.text, replyTo: event.message.ref, attachments: result.artifacts?.map((artifact) => ({ type: artifact.mime?.startsWith("image/") ? "image" : "file", artifact: artifact.ref, filename: artifact.filename })) };
        this.state.store.run("INSERT OR IGNORE INTO gateway_outbound_intents(id,invocation_id,target_json,message_json,status,attempts,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)", newId("outbound"), invocationId, JSON.stringify(event.conversation), JSON.stringify(message), "PENDING", 0, nowIso(), nowIso());
      });
    } catch (error) {
      this.state.store.run("UPDATE command_invocations SET status='FAILED',context_summary=?,updated_at=? WHERE id=?", String(error), nowIso(), invocationId);
      this.log.error("Direct command failed", { invocationId, command: name, error: String(error) });
      result = { text: "命令执行失败，错误已记录。" };
    }
    const intent = this.state.store.get<{ id: string }>("SELECT id FROM gateway_outbound_intents WHERE invocation_id=?", invocationId);
    if (intent) await this.deliverIntent(intent.id);
  }

  private async deliverIntent(intentId: string): Promise<void> {
    const row = this.state.store.get<{ id: string; invocation_id: string; target_json: string; message_json: string }>("SELECT id,invocation_id,target_json,message_json FROM gateway_outbound_intents WHERE id=? AND status='PENDING'", intentId);
    if (!row) return;
    this.state.store.run("UPDATE gateway_outbound_intents SET attempts=attempts+1,updated_at=? WHERE id=?", nowIso(), intentId);
    try {
      const target = JSON.parse(row.target_json) as ConversationAddress;
       const sent = await this.adapter.sendMessage(target, await this.prepareOutbound(JSON.parse(row.message_json) as OutgoingMessage, target));
      this.state.store.transaction(() => {
        this.state.store.run("UPDATE gateway_outbound_intents SET status='SENT',result_json=?,updated_at=? WHERE id=?", JSON.stringify(sent), nowIso(), intentId);
        const invocation = this.state.store.get<{ conversation_id: string; result_json: string | null }>("SELECT conversation_id,result_json FROM command_invocations WHERE id=?", row.invocation_id);
        const result = invocation?.result_json ? JSON.parse(invocation.result_json) as CommandResult : undefined;
        this.state.store.run("INSERT OR IGNORE INTO gateway_message_bindings(id,platform,account_id,platform_conversation_id,thread_id_json,message_id,invocation_id,created_at) VALUES (?,?,?,?,?,?,?,?)", newId("binding"), sent.message.platform, sent.message.accountId, sent.message.platformConversationId, JSON.stringify(sent.message.threadId), sent.message.messageId, row.invocation_id, nowIso());
        this.state.store.run("INSERT INTO recent_interactions(id,conversation_id,invocation_id,summary,result_ref,created_at) VALUES (?,?,?,?,?,?)", newId("recent"), invocation?.conversation_id ?? "", row.invocation_id, result?.context?.summary ?? result?.text ?? "", result?.context?.resultRef ?? null, nowIso());
      });
    } catch (error) {
      const message = String(error).slice(0, 2000);
      const status = this.isPermanentDeliveryFailure(message) ? "FAILED" : "PENDING";
      this.state.store.run("UPDATE gateway_outbound_intents SET status=?,last_error=?,updated_at=? WHERE id=?", status, message, nowIso(), intentId);
      this.log.error("Gateway outbound delivery failed", { intentId, error: String(error) });
    }
  }

  private async admitArtifacts(result: CommandResult, allowedRoot: string, event: ChatEvent, conversationId: string, invocationId: string, pluginId: string): Promise<CommandResult> {
    if (!result.artifacts?.length) return result;
    const artifacts = [];
    for (const artifact of result.artifacts) {
      if (artifact.ref.authority !== "bot-gateway") throw new Error("GATEWAY_ARTIFACT_AUTHORITY_REQUIRED");
      if (artifact.path) {
         const registered = await this.artifacts.registerLocalArtifact({ path: artifact.path, allowedRoot, conversationId, requesterId: event.sender.userId, filename: artifact.filename, mime: artifact.mime, maxBytes: this.config.runtime.maxArtifactBytes, ownerInvocationId: invocationId, ownerPluginId: pluginId });
        artifacts.push({ ...artifact, ref: registered.ref, filename: registered.filename, ...(registered.mime ? { mime: registered.mime } : {}), size: registered.size, path: undefined });
      } else {
        this.artifacts.authorize(artifact.ref, conversationId);
        artifacts.push({ ...artifact, path: undefined });
      }
    }
    return { ...result, artifacts };
  }

  private isPermanentDeliveryFailure(error: string): boolean {
     return /GATEWAY_ARTIFACT_(AUTHORITY_REQUIRED|NOT_AVAILABLE|DESTINATION_DENIED|EXPIRED|PATH_CHANGED|TRANSFER_UNAVAILABLE|INLINE_LIMIT)|ARTIFACT_(AUTHORIZATION|DESTINATION|EXPIRED|NOT_AVAILABLE|REFERENCE_REQUIRED)/.test(error);
  }

  private async prepareOutbound(message: OutgoingMessage, target: ConversationAddress): Promise<OutgoingMessage> {
    return { ...message, attachments: message.attachments ? await Promise.all(message.attachments.map(async (attachment) => {
       if (!attachment.artifact || attachment.artifact.authority !== "bot-gateway") return attachment;
       const conversationId = conversationKey(target.platform, target.accountId, target.platformConversationId, target.threadId);
       const url = this.artifacts.hasTransfer() ? this.artifacts.issueUrl(attachment.artifact, conversationId) : await this.artifacts.issueInlineUrl(attachment.artifact, conversationId);
       return { ...attachment, url };
     })) : undefined };
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
    const accountKey = `${event.platform}\u001f${event.accountId}`;
    const threadKey = JSON.stringify(event.conversation.threadId);
    const conversationKey = `${event.platform}\u001f${event.accountId}\u001f${event.conversation.kind}\u001f${event.conversation.platformConversationId}\u001f${threadKey}`;
    const accountOverride = this.config.chat.accountOverrides?.[accountKey];
    const override = this.config.chat.conversationOverrides[conversationKey];
    return { ...base, ...accountOverride, ...override };
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

  private audit(operation: string, decision: "ALLOW" | "DENY", reason: string | undefined, resource: string, requesterId: string, conversationId: string): void {
    this.state.store.run("INSERT INTO authorization_audit_events(id,operation,decision,reason,resource,requester_id,conversation_id,metadata_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)", newId("authz"), operation, decision, reason ?? null, resource, requesterId, conversationId, null, nowIso());
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
