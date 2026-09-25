import { mkdir, realpath, stat, unlink } from "node:fs/promises";
import { createWriteStream, createReadStream } from "node:fs";
import { once } from "node:events";
import { basename, join, relative, resolve } from "node:path";
import type { AppConfig } from "../config.js";
import type { ArtifactService } from "../runtime/artifacts.js";
import { SnowLumaMcpClient, type SnowLumaMcpActions } from "../runtime/snowluma-mcp.js";
import type { Logger } from "../shared/logger.js";
import { authorizeRead, authorizeSend } from "../auth.js";
import { NOT_IMPLEMENTED, type ArtifactRef, type ArtifactTransfer, type CapabilitySet, type ChatAttachmentRef, type ChatEvent, type ConversationAddress, type HistoryQuery, type OutgoingMessage, type PlatformMessageRef, type SendResult } from "../shared/types.js";
import { conversationMatchesAddress, messageMatchesReference, normalizeQQEvent } from "./adapter.js";

function integerValue(value: string, field: string): number {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < 1) throw new Error(`ONEBOT_INTEGER_REQUIRED:${field}`);
  return numeric;
}

function messageIdValue(value: string, field: string): number {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric)) throw new Error(`ONEBOT_INTEGER_REQUIRED:${field}`);
  return numeric;
}

export class SnowLumaQQCapability {
  private readonly config: AppConfig;
  private readonly artifacts: ArtifactService;
  private readonly mcp: SnowLumaMcpActions;
  private readonly mcpStreamDir: string;
  private readonly mcpUploadRoot: string;

  constructor(config: AppConfig, artifacts: ArtifactService, logger: Logger, mcp?: SnowLumaMcpActions) {
    this.config = config;
    this.artifacts = artifacts;
    this.mcp = mcp ?? new SnowLumaMcpClient(config, logger);
    this.mcpStreamDir = join(config.paths.stateRoot, "snowluma", "mcp", "streams");
    this.mcpUploadRoot = join(config.paths.stateRoot, "snowluma", "mcp", "uploads");
  }

  async sendMessage(target: ConversationAddress, message: OutgoingMessage, authorization?: { conversationId: string; capabilities: CapabilitySet; taskId?: string }): Promise<SendResult> {
    if (!authorization) throw new Error("SEND_AUTHORIZATION_REQUIRED");
    const sendAuthorization = authorizeSend(authorization.capabilities, authorization.conversationId);
    if (!sendAuthorization.allowed) throw new Error(`SEND_DENIED:${sendAuthorization.reason}`);
    const segments: Array<{ type: string; data: Record<string, string> }> = [];
    if (message.replyTo) segments.push({ type: "reply", data: { id: message.replyTo.messageId } });
    if (message.text) segments.push({ type: "text", data: { text: message.text } });
    for (const attachment of message.attachments ?? []) {
      if (!attachment.artifact) throw new Error("ARTIFACT_REFERENCE_REQUIRED");
      this.artifacts.authorizeOutbound(attachment.artifact, { taskId: authorization.taskId ?? "", destination: authorization.conversationId, capability: authorization.capabilities.artifacts });
      const file = await this.artifactFile(attachment.artifact, authorization);
      segments.push({ type: attachment.type, data: { file } });
    }
    const result = target.kind === "group"
      ? await this.mcp.invokeAction<{ message_id?: string | number }>("send_group_msg", { group_id: integerValue(target.platformConversationId, "group_id"), message: segments as never })
      : await this.mcp.invokeAction<{ message_id?: string | number }>("send_private_msg", { user_id: integerValue(target.platformConversationId, "user_id"), message: segments as never });
    const messageId = String(result.message_id ?? `outbound-${Date.now()}`);
    return { message: { platform: "qq", accountId: target.accountId, platformConversationId: target.platformConversationId, threadId: target.threadId, messageId }, raw: result as never };
  }

  async getMessage(ref: PlatformMessageRef, kind: ConversationAddress["kind"] = "group", authorization?: QQReadAuthorization): Promise<ChatEvent | null> {
    this.assertReadable(authorization);
    this.assertTarget(authorization, { platform: ref.platform, accountId: ref.accountId, kind, platformConversationId: ref.platformConversationId, threadId: ref.threadId });
    const raw = await this.mcp.queryAction<Record<string, unknown>>("get_msg", { message_id: messageIdValue(ref.messageId, "message_id") });
    const event = normalizeQQEvent({ ...raw, message_id: ref.messageId }, this.config, undefined, kind);
    if (event && !messageMatchesReference(event, ref, kind)) throw new Error("QQ_MESSAGE_SCOPE_MISMATCH");
    return event;
  }

  async getHistory(query: HistoryQuery, authorization?: QQReadAuthorization): Promise<ChatEvent[] | import("../shared/types.js").NotImplemented> {
    this.assertReadable(authorization);
    this.assertTarget(authorization, query.conversation);
    if (query.conversation.kind !== "group") return NOT_IMPLEMENTED;
    const params: Record<string, string | number> = { group_id: integerValue(query.conversation.platformConversationId, "group_id"), count: query.limit ?? 20 };
    if (query.beforeMessageId) params.message_id = messageIdValue(query.beforeMessageId, "message_id");
    const raw = await this.mcp.queryAction<{ messages?: unknown[] }>("get_group_msg_history", params);
    return (raw.messages ?? []).map((item) => normalizeQQEvent({ ...(item as Record<string, unknown>), message_type: "group", group_id: query.conversation.platformConversationId }, this.config)).filter((event): event is ChatEvent => event !== null && conversationMatchesAddress(event, query.conversation));
  }

  async fetchAttachment(attachment: ChatAttachmentRef, authorization?: QQReadAuthorization): Promise<ArtifactTransfer> {
    this.assertReadable(authorization);
    if (!attachment.id) throw new Error("ATTACHMENT_REFERENCE_MISSING");
    const result = await this.mcp.invokeAction<{ file_path?: string; file_size?: number }>("download_file_stream", { file_id: attachment.id });
    if (!result.file_path) throw new Error("ATTACHMENT_PATH_UNAVAILABLE");
    const filePath = await this.authorizedStreamPath(result.file_path);
    return { filename: attachment.filename ?? attachment.id ?? "attachment", ...(attachment.mime ? { mime: attachment.mime } : {}), ...(result.file_size !== undefined ? { size: result.file_size } : {}), stream: this.readAndRemove(filePath) };
  }

  private async artifactFile(ref: ArtifactRef, authorization: { conversationId: string; capabilities: CapabilitySet; taskId?: string }): Promise<string> {
    const artifact = await this.artifacts.openAuthorized(ref, { taskId: authorization.taskId, conversationId: authorization.conversationId, readCapability: authorization.capabilities.artifacts });
    if (artifact.metadata.size <= 8 * 1024 * 1024) {
      const chunks: Buffer[] = [];
      for await (const chunk of artifact.stream) chunks.push(Buffer.from(chunk));
      return `base64://${Buffer.concat(chunks).toString("base64")}`;
    }
    await mkdir(this.mcpUploadRoot, { recursive: true, mode: 0o700 });
    const target = join(this.mcpUploadRoot, `${ref.artifactId}-${basename(artifact.metadata.filename).replace(/[^A-Za-z0-9._-]/g, "_")}`);
    const output = createWriteStream(target, { mode: 0o600 });
    try {
      for await (const chunk of artifact.stream) if (!output.write(chunk)) await once(output, "drain");
      await new Promise<void>((resolvePromise, reject) => { output.once("error", reject); output.once("close", resolvePromise); output.end(); });
      const uploaded = await this.mcp.invokeAction<{ file_path?: string }>("upload_file_stream", { filename: artifact.metadata.filename }, { input_file: target });
      if (!uploaded.file_path) throw new Error("ARTIFACT_UPLOAD_PATH_UNAVAILABLE");
      return uploaded.file_path;
    } catch (error) {
      output.destroy();
      throw error;
    } finally {
      await unlink(target).catch(() => undefined);
    }
  }

  private assertReadable(authorization: QQReadAuthorization | undefined): asserts authorization is QQReadAuthorization {
    if (!authorization) throw new Error("QQ_READ_AUTHORIZATION_REQUIRED");
    const decision = authorizeRead(authorization.capabilities, authorization.conversationId);
    if (!decision.allowed) throw new Error(`QQ_READ_DENIED:${decision.reason}`);
  }

  private assertTarget(authorization: QQReadAuthorization, target: ConversationAddress): void {
    if (authorization.target && (authorization.target.platform !== target.platform || authorization.target.accountId !== target.accountId || authorization.target.kind !== target.kind || authorization.target.platformConversationId !== target.platformConversationId || JSON.stringify(authorization.target.threadId) !== JSON.stringify(target.threadId))) throw new Error("QQ_READ_TARGET_MISMATCH");
  }

  private async authorizedStreamPath(filePath: string): Promise<string> {
    let root: string;
    let candidate: string;
    try {
      root = await realpath(this.mcpStreamDir);
      candidate = await realpath(resolve(filePath));
      if (!(await stat(candidate)).isFile()) throw new Error("ATTACHMENT_PATH_DENIED");
    } catch (error) {
      if (error instanceof Error && error.message === "ATTACHMENT_PATH_DENIED") throw error;
      throw new Error("ATTACHMENT_PATH_DENIED");
    }
    const child = relative(root, candidate);
    if (!child || child === ".." || child.startsWith("../") || child.startsWith("..\\")) throw new Error("ATTACHMENT_PATH_DENIED");
    return candidate;
  }

  private async *readAndRemove(filePath: string): AsyncIterable<Uint8Array> {
    try {
      for await (const chunk of createReadStream(filePath)) yield chunk as Uint8Array;
    } finally {
      await unlink(filePath).catch(() => undefined);
    }
  }
}

type QQReadAuthorization = { conversationId: string; capabilities: CapabilitySet; target: ConversationAddress };
