import type { AppConfig } from "../config.js";
import type { ArtifactService } from "../runtime/artifacts.js";
import type { Logger } from "../shared/logger.js";
import type { ArtifactRef, ChatEvent, ConversationAddress, HistoryQuery, OutgoingMessage, PlatformMessageRef, SendResult } from "../shared/types.js";
import { OneBotClient } from "./onebot.js";

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
    const result = await this.client.action<{ message_id?: string }>("send_msg", target.kind === "group" ? { group_id: target.platformConversationId, message: segments as never } : { user_id: target.platformConversationId, message: segments as never });
    const messageId = String(result.message_id ?? `outbound-${Date.now()}`);
    return { message: { platform: "qq", accountId: target.accountId, platformConversationId: target.platformConversationId, threadId: target.threadId, messageId }, raw: result as never };
  }

  async getMessage(ref: PlatformMessageRef): Promise<ChatEvent | null> {
    // The adapter's normalizer is deliberately kept on the host boundary. Runtime only
    // uses this method for a lazy lookup when the platform response is needed.
    const raw = await this.client.action<Record<string, unknown>>("get_msg", { message_id: ref.messageId });
    return raw as never;
  }

  async getHistory(query: HistoryQuery): Promise<ChatEvent[]> {
    const raw = await this.client.action<unknown[]>("get_group_msg_history", { group_id: query.conversation.platformConversationId, count: query.limit ?? 20 });
    return raw as ChatEvent[];
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
