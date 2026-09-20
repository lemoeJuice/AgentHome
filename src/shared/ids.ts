import { createHash, randomUUID } from "node:crypto";

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function namespaceKey(parts: Array<string | null | undefined>): string {
  return parts.map((part) => part ?? "<null>").join("\u001f");
}

export function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

export function conversationKey(platform: string, accountId: string, platformConversationId: string, threadId: unknown): string {
  return namespaceKey([platform, accountId, platformConversationId, JSON.stringify(threadId)]);
}

export function messageKey(ref: { platform: string; accountId: string; platformConversationId: string; threadId: unknown; messageId: string }): string {
  return namespaceKey([ref.platform, ref.accountId, ref.platformConversationId, JSON.stringify(ref.threadId), ref.messageId]);
}
