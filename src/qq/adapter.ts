import type { AppConfig } from "../config.js";
import { Logger } from "../shared/logger.js";
import { NOT_IMPLEMENTED, type ChatAttachmentRef, type ChatEvent, type ChatPlatformAdapter, type ConversationAddress, type HistoryQuery, type OutgoingMessage, type PlatformMessageRef, type SendResult, type ArtifactTransfer } from "../shared/types.js";
import { OneBotClient, resolveWebSocketEndpoint } from "./onebot.js";
import { snowlumaAccessToken, snowlumaWebSocketAccessToken } from "../config.js";

type Segment = { type: string; data?: Record<string, unknown> } | string;

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}

function integerValue(value: string | number | undefined, field: string): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < 1) throw new Error(`ONEBOT_INTEGER_REQUIRED:${field}`);
  return numeric;
}

export function parseSegments(message: unknown, botId?: string): { text: string | null; mentionsBot: boolean; replyTo: PlatformMessageRef | null; attachments: ChatAttachmentRef[] } {
  const segments: Segment[] = Array.isArray(message) ? message as Segment[] : [{ type: "text", data: { text: String(message ?? "") } }];
  const textParts: string[] = [];
  const attachments: ChatAttachmentRef[] = [];
  let replyTo: PlatformMessageRef | null = null;
  let mentionsBot = false;
  for (const segment of segments) {
    if (typeof segment === "string") { textParts.push(segment); continue; }
    const data = segment.data ?? {};
    if (segment.type === "text") { const text = stringValue(data.text); if (text) textParts.push(text); }
    if (segment.type === "at") { const qq = stringValue(data.qq); mentionsBot ||= qq === "all" || (Boolean(botId) && qq === botId); textParts.push(qq === "all" ? "@all" : `@${qq ?? ""}`); }
    if (segment.type === "reply" && data.id !== undefined) { const id = stringValue(data.id); if (id) replyTo = { platform: "qq", accountId: "", platformConversationId: "", threadId: null, messageId: id }; }
    if (segment.type === "image") attachments.push({ type: "image", ...(stringValue(data.file) ? { id: stringValue(data.file) } : {}), ...(stringValue(data.url) ? { url: stringValue(data.url) } : {}), raw: data as never });
    if (segment.type === "file") attachments.push({ type: "file", ...(stringValue(data.file) ? { id: stringValue(data.file) } : {}), ...(stringValue(data.url) ? { url: stringValue(data.url) } : {}), ...(stringValue(data.name) ? { filename: stringValue(data.name) } : {}), raw: data as never });
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
      websocketEndpoint: resolveWebSocketEndpoint(config.snowluma.endpoint, config.snowluma.reverseWebSocketPath),
      apiEndpoint: config.snowluma.apiEndpoint,
      accessToken: snowlumaAccessToken(config),
      websocketAccessToken: snowlumaWebSocketAccessToken(config),
      reconnectMs: config.snowluma.reconnectMs,
      requestTimeoutMs: config.snowluma.requestTimeoutMs,
    }, logger.child("qq"));
  }

  async start(onEvent: (event: ChatEvent) => Promise<void>): Promise<void> {
    this.onEvent = onEvent;
    await this.client.start(async (raw) => {
      if (raw.post_type !== "message") return;
      const event = this.normalize(raw);
      if (event) await this.onEvent?.(event);
    }, async () => {
      try { this.botId = stringValue((await this.client.action<{ user_id?: string }>("get_login_info")).user_id); }
      catch { /* inbound can start before API becomes reachable; the next reconnect retries */ }
    });
  }

  async stop(): Promise<void> { await this.client.stop(); }

  async sendMessage(target: ConversationAddress, message: OutgoingMessage): Promise<SendResult> {
    const segments: Array<{ type: string; data: Record<string, string> }> = [];
    if (message.replyTo) segments.push({ type: "reply", data: { id: message.replyTo.messageId } });
    if (message.text) segments.push({ type: "text", data: { text: message.text } });
    for (const attachment of message.attachments ?? []) {
      if (!attachment.artifact) throw new Error("ARTIFACT_REFERENCE_REQUIRED");
      if (!attachment.url) throw new Error("ARTIFACT_TRANSFER_UNAVAILABLE: authorized transfer URL is required");
      segments.push({ type: attachment.type, data: { file: attachment.url } });
    }
    const params = target.kind === "group"
      ? { group_id: integerValue(target.platformConversationId, "group_id"), message: segments }
      : { user_id: integerValue(target.platformConversationId, "user_id"), message: segments };
    const result = await this.client.action<{ message_id?: string | number }>(target.kind === "group" ? "send_group_msg" : "send_private_msg", params as never);
    const messageId = stringValue(result.message_id) ?? `unknown-${Date.now()}`;
    return { message: { platform: "qq", accountId: target.accountId, platformConversationId: target.platformConversationId, threadId: target.threadId, messageId }, raw: result as never };
  }

  async getMessage(ref: PlatformMessageRef, kind?: ConversationAddress["kind"]): Promise<ChatEvent | null> {
    const raw = await this.client.action<Record<string, unknown>>("get_msg", { message_id: integerValue(ref.messageId, "message_id") });
    const event = this.normalize({ ...raw, post_type: "message", message_type: raw.message_type ?? kind ?? (ref.platformConversationId ? "group" : "private"), user_id: raw.user_id ?? "unknown", message_id: ref.messageId, group_id: raw.group_id ?? (ref.platformConversationId || undefined) });
    if (event && !messageMatchesReference(event, ref)) throw new Error("QQ_MESSAGE_SCOPE_MISMATCH");
    return event;
  }

  async getRecentMessages(query: HistoryQuery): Promise<ChatEvent[] | import("../shared/types.js").NotImplemented> {
    if (query.conversation.kind !== "group") return NOT_IMPLEMENTED;
    const params: Record<string, string | number> = { group_id: integerValue(query.conversation.platformConversationId, "group_id"), count: query.limit ?? 20 };
    if (query.beforeMessageId) params.message_id = integerValue(query.beforeMessageId, "message_id");
    const raw = await this.client.action<{ messages?: unknown[] }>("get_group_msg_history", params);
    return (raw.messages ?? []).map((item) => this.normalize({ ...(item as Record<string, unknown>), post_type: "message", message_type: "group", group_id: query.conversation.platformConversationId })).filter((event): event is ChatEvent => event !== null && conversationMatchesAddress(event, query.conversation));
  }

  async fetchAttachment(attachment: ChatAttachmentRef): Promise<ArtifactTransfer> {
    const result = await this.resolveAttachment(attachment);
    const response = await fetch(result.url);
    if (!response.ok || !response.body) throw new Error(`ATTACHMENT_DOWNLOAD_FAILED:${response.status}`);
    return {
      filename: attachment.filename ?? attachment.id ?? "attachment",
      ...(attachment.mime ? { mime: attachment.mime } : {}),
      ...(result.size ? { size: result.size } : {}),
      stream: response.body as unknown as AsyncIterable<Uint8Array>,
    };
  }

  async resolveAttachment(attachment: ChatAttachmentRef): Promise<{ url: string; size?: number }> {
    const fileId = attachment.id;
    if (!fileId) {
      if (attachment.url) return { url: attachment.url, ...(attachment.size ? { size: attachment.size } : {}) };
      throw new Error("ATTACHMENT_REFERENCE_MISSING");
    }
    const result = await this.client.action<{ url?: string; file_size?: number }>("get_file", { file_id: fileId });
    if (!result.url) throw new Error("ATTACHMENT_URL_UNAVAILABLE");
    return { url: result.url, ...(result.file_size ? { size: result.file_size } : {}) };
  }

  private normalize(raw: Record<string, unknown>): ChatEvent | null { return normalizeQQEvent(raw, this.config, this.botId); }
}

export function normalizeQQEvent(raw: Record<string, unknown>, config: AppConfig, botId?: string, fallbackKind?: "private" | "group"): ChatEvent | null {
  const messageType = raw.message_type === "group" ? "group" : raw.message_type === "private" ? "private" : fallbackKind ?? null;
  if (!messageType) return null;
  const userId = stringValue(raw.user_id) ?? "unknown";
  const accountId = config.snowluma.accountId;
  const platformConversationId = stringValue(messageType === "group" ? raw.group_id : raw.user_id) ?? userId;
  const address: ConversationAddress = { platform: "qq", accountId, kind: messageType, platformConversationId, threadId: NOT_IMPLEMENTED };
  const parsed = parseSegments(raw.message, botId);
  const replyTo = parsed.replyTo ? { ...parsed.replyTo, accountId, platformConversationId, threadId: address.threadId } : null;
  return {
    platform: "qq", accountId,
    sender: { platform: "qq", accountId, userId },
    conversation: address,
    message: {
      ref: { platform: "qq", accountId, platformConversationId, threadId: address.threadId, messageId: stringValue(raw.message_id) ?? `event-${Date.now()}` },
      text: parsed.text,
      replyTo,
      mentionsBot: parsed.mentionsBot,
      attachments: parsed.attachments,
      rawSegments: (Array.isArray(raw.message) ? raw.message : []) as never,
    },
    timestamp: new Date(Number(raw.time ?? Math.floor(Date.now() / 1000)) * 1000).toISOString(),
    extensions: { postType: String(raw.post_type ?? "message"), rawSender: (raw.sender ?? null) as never },
  };
}

export function conversationMatchesAddress(event: ChatEvent, address: ConversationAddress): boolean {
  return event.platform === address.platform
    && event.accountId === address.accountId
    && event.conversation.kind === address.kind
    && event.conversation.platformConversationId === address.platformConversationId
    && threadMatches(event.conversation.threadId, address.threadId);
}

export function messageMatchesReference(event: ChatEvent, ref: PlatformMessageRef, kind?: ConversationAddress["kind"]): boolean {
  return event.platform === ref.platform
    && event.accountId === ref.accountId
    && (!kind || event.conversation.kind === kind)
    && event.conversation.platformConversationId === ref.platformConversationId
    && threadMatches(event.conversation.threadId, ref.threadId)
    && event.message.ref.messageId === ref.messageId;
}

function threadMatches(left: ConversationAddress["threadId"], right: ConversationAddress["threadId"]): boolean {
  const unsupported = (value: unknown) => Boolean(value && typeof value === "object" && "kind" in value && (value as { kind?: unknown }).kind === "NOT_IMPLEMENTED");
  return (left === null && unsupported(right)) || (right === null && unsupported(left)) || JSON.stringify(left) === JSON.stringify(right);
}

export { OneBotClient };
