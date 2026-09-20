import type { AppConfig } from "../config.js";
import { Logger } from "../shared/logger.js";
import { NOT_IMPLEMENTED, type ChatAttachmentRef, type ChatEvent, type ChatPlatformAdapter, type ConversationAddress, type HistoryQuery, type OutgoingMessage, type PlatformMessageRef, type SendResult, type ArtifactTransfer } from "../shared/types.js";
import { OneBotClient } from "./onebot.js";

type Segment = { type: string; data?: Record<string, string> } | string;

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}

function parseSegments(message: unknown): { text: string | null; mentionsBot: boolean; replyTo: PlatformMessageRef | null; attachments: ChatAttachmentRef[] } {
  const segments: Segment[] = Array.isArray(message) ? message as Segment[] : [{ type: "text", data: { text: String(message ?? "") } }];
  const textParts: string[] = [];
  const attachments: ChatAttachmentRef[] = [];
  let replyTo: PlatformMessageRef | null = null;
  let mentionsBot = false;
  for (const segment of segments) {
    if (typeof segment === "string") { textParts.push(segment); continue; }
    const data = segment.data ?? {};
    if (segment.type === "text") textParts.push(data.text ?? "");
    if (segment.type === "at") { mentionsBot ||= data.qq === "all" || Boolean(data.qq); textParts.push(data.qq === "all" ? "@all" : `@${data.qq ?? ""}`); }
    if (segment.type === "reply" && data.id) replyTo = { platform: "qq", accountId: "", platformConversationId: "", threadId: null, messageId: data.id };
    if (segment.type === "image") attachments.push({ type: "image", id: data.file, url: data.url, raw: data as never });
    if (segment.type === "file") attachments.push({ type: "file", id: data.file, url: data.url, filename: data.name, raw: data as never });
    if (segment.type !== "text" && segment.type !== "at" && segment.type !== "reply" && segment.type !== "image" && segment.type !== "file") attachments.push({ type: "unknown", raw: data as never });
  }
  const text = textParts.join("").trim();
  return { text: text || null, mentionsBot, replyTo, attachments };
}

export class QQChatPlatformAdapter implements ChatPlatformAdapter {
  readonly platform = "qq";
  private readonly config: AppConfig;
  private readonly client: OneBotClient;
  private botId: string | undefined;
  private onEvent: ((event: ChatEvent) => Promise<void>) | undefined;

  constructor(config: AppConfig, logger: Logger) {
    this.config = config;
    this.client = new OneBotClient({
      websocketEndpoint: config.snowluma.endpoint,
      apiEndpoint: config.snowluma.apiEndpoint,
      accessToken: process.env[config.snowluma.accessTokenEnv],
      reconnectMs: config.snowluma.reconnectMs,
      requestTimeoutMs: config.snowluma.requestTimeoutMs,
    }, logger.child("qq"));
  }

  async start(onEvent: (event: ChatEvent) => Promise<void>): Promise<void> {
    this.onEvent = onEvent;
    try { this.botId = stringValue((await this.client.action<{ user_id?: string }>("get_login_info")).user_id); } catch { /* inbound can start before API becomes reachable */ }
    await this.client.start(async (raw) => {
      if (raw.post_type !== "message") return;
      const event = this.normalize(raw);
      if (event) await this.onEvent?.(event);
    });
  }

  async stop(): Promise<void> { await this.client.stop(); }

  async sendMessage(target: ConversationAddress, message: OutgoingMessage): Promise<SendResult> {
    const segments: Array<{ type: string; data: Record<string, string> }> = [];
    if (message.replyTo) segments.push({ type: "reply", data: { id: message.replyTo.messageId } });
    if (message.text) segments.push({ type: "text", data: { text: message.text } });
    for (const attachment of message.attachments ?? []) {
      if (!attachment.url) throw new Error("ARTIFACT_TRANSFER_REQUIRED: QQ adapter only accepts a remote upload URL");
      segments.push({ type: attachment.type, data: { file: attachment.url } });
    }
    const params: Record<string, string | number | Array<{ type: string; data: Record<string, string> }>> = target.kind === "group"
      ? { group_id: target.platformConversationId, message: segments }
      : { user_id: target.platformConversationId, message: segments };
    const result = await this.client.action<{ message_id?: string }>("send_msg", params as never);
    const messageId = stringValue(result.message_id) ?? `unknown-${Date.now()}`;
    return { message: { platform: "qq", accountId: target.accountId, platformConversationId: target.platformConversationId, threadId: target.threadId, messageId }, raw: result as never };
  }

  async getMessage(ref: PlatformMessageRef): Promise<ChatEvent | null> {
    const raw = await this.client.action<Record<string, unknown>>("get_msg", { message_id: ref.messageId });
    return this.normalize({ ...raw, post_type: "message", message_type: raw.message_type ?? (ref.platformConversationId ? "group" : "private"), user_id: raw.user_id ?? "unknown", message_id: ref.messageId, group_id: raw.group_id ?? (ref.platformConversationId || undefined) });
  }

  async getRecentMessages(query: HistoryQuery): Promise<ChatEvent[]> {
    if (query.conversation.kind !== "group") return [];
    const raw = await this.client.action<unknown[]>("get_group_msg_history", { group_id: query.conversation.platformConversationId, count: query.limit ?? 20, message_seq: query.beforeMessageId ?? "" });
    return raw.map((item) => this.normalize({ ...(item as Record<string, unknown>), post_type: "message", message_type: "group", group_id: query.conversation.platformConversationId })).filter((event): event is ChatEvent => event !== null);
  }

  async fetchAttachment(attachment: ChatAttachmentRef): Promise<ArtifactTransfer> {
    const fileId = attachment.id;
    if (!fileId) throw new Error("ATTACHMENT_REFERENCE_MISSING");
    const result = await this.client.action<{ url?: string; file?: string; file_size?: number }>("get_file", { file: fileId });
    const remoteUrl = result.url;
    if (!remoteUrl) throw new Error("ATTACHMENT_URL_UNAVAILABLE");
    const response = await fetch(remoteUrl);
    if (!response.ok || !response.body) throw new Error(`ATTACHMENT_DOWNLOAD_FAILED:${response.status}`);
    return {
      filename: attachment.filename ?? fileId,
      ...(attachment.mime ? { mime: attachment.mime } : {}),
      ...(result.file_size ? { size: result.file_size } : {}),
      stream: response.body as unknown as AsyncIterable<Uint8Array>,
    };
  }

  private normalize(raw: Record<string, unknown>): ChatEvent | null {
    const messageType = raw.message_type === "group" ? "group" : raw.message_type === "private" ? "private" : null;
    if (!messageType) return null;
    const userId = stringValue(raw.user_id) ?? "unknown";
    const accountId = this.config.snowluma.accountId;
    const platformConversationId = stringValue(messageType === "group" ? raw.group_id : raw.user_id) ?? userId;
    const address: ConversationAddress = { platform: "qq", accountId, kind: messageType, platformConversationId, threadId: NOT_IMPLEMENTED };
    const parsed = parseSegments(raw.message);
    const replyTo = parsed.replyTo ? { ...parsed.replyTo, accountId, platformConversationId, threadId: address.threadId } : null;
    return {
      platform: "qq", accountId,
      sender: { platform: "qq", accountId, userId },
      conversation: address,
      message: {
        ref: { platform: "qq", accountId, platformConversationId, threadId: address.threadId, messageId: stringValue(raw.message_id) ?? `event-${Date.now()}` },
        text: parsed.text,
        replyTo,
        mentionsBot: this.botId ? parsed.mentionsBot && String(raw.message).includes(this.botId) : parsed.mentionsBot,
        attachments: parsed.attachments,
        rawSegments: (Array.isArray(raw.message) ? raw.message : []) as never,
      },
      timestamp: new Date(Number(raw.time ?? Math.floor(Date.now() / 1000)) * 1000).toISOString(),
      extensions: { postType: String(raw.post_type ?? "message"), rawSender: (raw.sender ?? null) as never },
    };
  }
}

export { OneBotClient };
