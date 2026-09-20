import type { AppConfig } from "../config.js";
import type { ArtifactService } from "../runtime/artifacts.js";
import type { Logger } from "../shared/logger.js";
import type { ArtifactRef, ArtifactTransfer, ChatAttachmentRef, ChatEvent, ConversationAddress, HistoryQuery, OutgoingMessage, PlatformMessageRef, SendResult } from "../shared/types.js";
import { OneBotClient } from "./onebot.js";

function integerValue(value: string, field: string): number {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < 1) throw new Error(`ONEBOT_INTEGER_REQUIRED:${field}`);
  return numeric;
}

export class SnowLumaQQCapability {
  private readonly client: OneBotClient;
  private readonly config: AppConfig;
  private readonly artifacts: ArtifactService;

  constructor(config: AppConfig, artifacts: ArtifactService, logger: Logger, accessToken?: string) {
    this.config = config; this.artifacts = artifacts;
    this.client = new OneBotClient({ websocketEndpoint: config.snowluma.endpoint, apiEndpoint: config.snowluma.apiEndpoint, accessToken, reconnectMs: config.snowluma.reconnectMs, requestTimeoutMs: config.snowluma.requestTimeoutMs }, logger.child("qq-capability"));
  }

  async sendMessage(target: ConversationAddress, message: OutgoingMessage): Promise<SendResult> {
    const segments: Array<{ type: string; data: Record<string, string> }> = [];
    if (message.replyTo) segments.push({ type: "reply", data: { id: message.replyTo.messageId } });
    if (message.text) segments.push({ type: "text", data: { text: message.text } });
    for (const attachment of message.attachments ?? []) {
      if (attachment.url) segments.push({ type: attachment.type, data: { file: attachment.url } });
      else if (attachment.artifact) {
        // Standard OneBot has no byte-upload method. The supported portable path is a
        // short-lived URL reachable by SnowLuma; ArtifactService owns its authorization.
        const url = await this.remoteArtifactUrl(attachment.artifact);
        segments.push({ type: attachment.type, data: { file: url } });
      } else throw new Error("ARTIFACT_REFERENCE_REQUIRED");
    }
    const result = target.kind === "group"
      ? await this.client.action<{ message_id?: string | number }>("send_group_msg", { group_id: integerValue(target.platformConversationId, "group_id"), message: segments as never })
      : await this.client.action<{ message_id?: string | number }>("send_private_msg", { user_id: integerValue(target.platformConversationId, "user_id"), message: segments as never });
    const messageId = String(result.message_id ?? `outbound-${Date.now()}`);
    return { message: { platform: "qq", accountId: target.accountId, platformConversationId: target.platformConversationId, threadId: target.threadId, messageId }, raw: result as never };
  }

  async getMessage(ref: PlatformMessageRef): Promise<ChatEvent | null> {
    // The adapter's normalizer is deliberately kept on the host boundary. Runtime only
    // uses this method for a lazy lookup when the platform response is needed.
    const raw = await this.client.action<Record<string, unknown>>("get_msg", { message_id: integerValue(ref.messageId, "message_id") });
    return raw as never;
  }

  async getHistory(query: HistoryQuery): Promise<ChatEvent[]> {
    const params: Record<string, string | number> = { group_id: integerValue(query.conversation.platformConversationId, "group_id"), count: query.limit ?? 20 };
    if (query.beforeMessageId) params.message_id = integerValue(query.beforeMessageId, "message_id");
    const raw = await this.client.action<{ messages?: unknown[] }>("get_group_msg_history", params);
    return (raw.messages ?? []) as ChatEvent[];
  }

  async fetchAttachment(attachment: ChatAttachmentRef): Promise<ArtifactTransfer> {
    if (!attachment.id) throw new Error("ATTACHMENT_REFERENCE_MISSING");
    const result = await this.client.action<{ url?: string; file_size?: number }>("get_file", { file_id: attachment.id });
    if (!result.url) throw new Error("ATTACHMENT_URL_UNAVAILABLE");
    const response = await fetch(result.url);
    if (!response.ok || !response.body) throw new Error(`ATTACHMENT_DOWNLOAD_FAILED:${response.status}`);
    return { filename: attachment.filename ?? attachment.id, ...(attachment.mime ? { mime: attachment.mime } : {}), ...(result.file_size ? { size: result.file_size } : {}), stream: response.body as unknown as AsyncIterable<Uint8Array> };
  }

  private async remoteArtifactUrl(ref: ArtifactRef): Promise<string> {
    const artifact = await this.artifacts.open(ref);
    if (artifact.metadata.size <= 8 * 1024 * 1024) {
      const chunks: Buffer[] = [];
      for await (const chunk of artifact.stream) chunks.push(Buffer.from(chunk));
      return `base64://${Buffer.concat(chunks).toString("base64")}`;
    }
    const configured = process.env.AGENT_ARTIFACT_PUBLIC_BASE_URL;
    if (!configured) throw new Error("ARTIFACT_TRANSFER_UNAVAILABLE: set AGENT_ARTIFACT_PUBLIC_BASE_URL to a scoped upload gateway");
    return `${configured.replace(/\/$/, "")}/${encodeURIComponent(ref.artifactId)}`;
  }
}
