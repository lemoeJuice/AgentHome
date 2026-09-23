export type JsonObject = { [key: string]: JsonValue };
export type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];

export type NotImplemented = { readonly kind: "NOT_IMPLEMENTED" };
export const NOT_IMPLEMENTED: NotImplemented = Object.freeze({ kind: "NOT_IMPLEMENTED" });
export type NullableOrUnsupported<T> = T | null | NotImplemented;

export interface PlatformIdentityRef {
  platform: string;
  accountId: string;
  userId: string;
}

export interface ConversationAddress {
  platform: string;
  accountId: string;
  kind: "private" | "group";
  platformConversationId: string;
  threadId: NullableOrUnsupported<string>;
}

export interface PlatformMessageRef {
  platform: string;
  accountId: string;
  platformConversationId: string;
  threadId: NullableOrUnsupported<string>;
  messageId: string;
}

export type ChatAttachmentRef = {
  type: "image" | "file" | "video" | "audio" | "unknown";
  id?: string;
  url?: string;
  filename?: string;
  mime?: string;
  size?: number;
  raw?: JsonValue;
};

export interface ChatEvent {
  platform: string;
  accountId: string;
  sender: PlatformIdentityRef;
  conversation: ConversationAddress;
  message: {
    ref: PlatformMessageRef;
    text: string | null;
    replyTo: NullableOrUnsupported<PlatformMessageRef>;
    mentionsBot: boolean | NotImplemented;
    attachments: ChatAttachmentRef[];
    rawSegments?: JsonValue[];
  };
  timestamp: string;
  extensions?: JsonObject;
}

export interface OutgoingMessage {
  text?: string;
  replyTo?: PlatformMessageRef | null;
  attachments?: Array<{
    type: "image" | "file";
    artifact?: ArtifactRef;
    filename?: string;
    url?: string;
  }>;
}

export interface SendResult {
  message: PlatformMessageRef;
  raw?: JsonValue;
}

export interface HistoryQuery {
  conversation: ConversationAddress;
  limit?: number;
  beforeMessageId?: string;
}

export interface ChatPlatformAdapter {
  readonly platform: string;
  start(onEvent: (event: ChatEvent) => Promise<void>): Promise<void>;
  stop(): Promise<void>;
  sendMessage(target: ConversationAddress, message: OutgoingMessage): Promise<SendResult>;
  getMessage(ref: PlatformMessageRef): Promise<ChatEvent | null | NotImplemented>;
  getRecentMessages(query: HistoryQuery): Promise<ChatEvent[] | NotImplemented>;
  fetchAttachment(attachment: ChatAttachmentRef): Promise<ArtifactTransfer | NotImplemented>;
}

export interface ArtifactRef {
  authority: "agent-home" | "bot-gateway";
  artifactId: string;
}

export interface ArtifactTransfer {
  filename: string;
  mime?: string;
  size?: number;
  stream: AsyncIterable<Uint8Array>;
}

export interface ControllerEventEnvelope {
  protocolVersion: 1;
  eventId: string;
  instanceId: string;
  type: "chat.message" | "chat.notice" | "control.command" | "control.health";
  occurredAt: string;
  source: { platform: string; accountId: string; adapter: string };
  trustedIdentity?: { userId: string; principalId?: string };
  conversation?: {
    conversationId: string;
    address: ConversationAddress;
  };
  message?: { ref: PlatformMessageRef; replyTo: NullableOrUnsupported<PlatformMessageRef> };
  payload: JsonValue;
}

export interface ControlAck {
  eventId: string;
  status: "accepted" | "duplicate" | "rejected" | "failed";
  receivedAt: string;
  errorCode?: string;
}

export type Trust = "OWNER" | "GUEST";
export type MemoryScope = "owner_private" | "global_agent" | `user:${string}` | `group:${string}` | `project:${string}`;

export interface RequesterContext {
  platform: string;
  accountId: string;
  userId: string;
  principalId?: string;
  trust: Trust;
  conversationId: string;
}

export interface CapabilitySet {
  memory: { allowedScopes: MemoryScope[] };
  projects: Array<{ projectId: string; access: "READ" | "WRITE" }>;
  qq: { readConversations: string[]; sendConversations: string[] };
  plugins: { allowedActions: string[] };
  artifacts: { readableArtifactAuthorities: string[]; publishTaskIds: string[]; allowedDestinations: string[] };
  tasks: { canCreate: boolean; visibleTaskIds: string[]; canCancel: boolean; canFollowUp: boolean };
}

export interface ConversationRecord {
  conversationId: string;
  address: ConversationAddress;
  principalId?: string;
  trust: Trust;
  memoryScopes: MemoryScope[];
  mainSessionId?: string;
  mainSessionPath?: string;
}

export type TaskStatus = "CREATED" | "QUEUED" | "RUNNING" | "WAITING_USER" | "PAUSED" | "COMPLETED" | "PARTIAL" | "FAILED" | "CANCELLED" | "INTERRUPTED";
export type WorkerStatus = "PENDING" | "STARTING" | "RUNNING" | "WAITING_USER" | "STOPPING" | "COMPLETED" | "FAILED" | "CANCELLED" | "INTERRUPTED";

export interface TaskRequester {
  platform: string;
  accountId: string;
  userId: string;
  principalId?: string;
}

export interface TaskRecord {
  id: string;
  title: string;
  goal: string;
  status: TaskStatus;
  requester: TaskRequester;
  trust: Trust;
  originConversationId: string;
  notificationConversationId: string;
  parentTaskId?: string;
  capabilities: CapabilitySet;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface WorkerExecutionRecord {
  id: string;
  taskId: string;
  objective: string;
  status: WorkerStatus;
  harness: "pi";
  harnessSessionId?: string;
  workspaceId?: string;
  workspaceAccess?: "READ" | "WRITE";
  artifactRefs?: ArtifactRef[];
  capabilities?: CapabilitySet;
  processId?: number;
  startedAt?: string;
  updatedAt: string;
  finishedAt?: string;
}
