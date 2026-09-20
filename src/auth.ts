import type { CapabilitySet, ConversationAddress, MemoryScope, RequesterContext, Trust } from "./shared/types.js";

export function deriveCapabilities(requester: RequesterContext, conversation: ConversationAddress, owner: { platform: string; accountId: string; userId: string }, conversationId: string): CapabilitySet {
  const isOwner = requester.platform === owner.platform && requester.accountId === owner.accountId && requester.userId === owner.userId;
  const trust: Trust = isOwner ? "OWNER" : "GUEST";
  const baseScopes: MemoryScope[] = ["global_agent", `group:${conversationId}`];
  if (trust === "OWNER" && conversation.kind === "private") baseScopes.push("owner_private", `user:${requester.principalId ?? requester.userId}`);
  const canCreate = trust === "OWNER";
  return {
    memory: { allowedScopes: baseScopes },
    projects: trust === "OWNER" ? [{ projectId: "*", access: "WRITE" }] : [],
    qq: { readConversations: [conversationId], sendConversations: [conversationId] },
    plugins: { allowedActions: [] },
    artifacts: { publishTaskIds: [], allowedDestinations: [conversationId] },
    tasks: { canCreate, visibleTaskIds: [], canCancel: trust === "OWNER", canFollowUp: true },
  };
}

function containsProject(parent: CapabilitySet, projectId: string, access: "READ" | "WRITE"): boolean {
  return parent.projects.some((item) => (item.projectId === "*" || item.projectId === projectId) && (item.access === "WRITE" || item.access === access));
}

export function attenuateTask(parent: CapabilitySet, requested: Partial<CapabilitySet>, taskId: string): CapabilitySet {
  const projects = (requested.projects ?? parent.projects).filter((item) => containsProject(parent, item.projectId, item.access));
  const memory = (requested.memory?.allowedScopes ?? parent.memory.allowedScopes).filter((scope) => parent.memory.allowedScopes.includes(scope));
  const qq = requested.qq ?? parent.qq;
  const sendConversations = qq.sendConversations.filter((conversation) => parent.qq.sendConversations.includes(conversation));
  const readConversations = qq.readConversations.filter((conversation) => parent.qq.readConversations.includes(conversation));
  const allowedDestinations = (requested.artifacts?.allowedDestinations ?? parent.artifacts.allowedDestinations).filter((destination) => parent.artifacts.allowedDestinations.includes(destination));
  return {
    memory: { allowedScopes: memory }, projects, qq: { readConversations, sendConversations },
    plugins: { allowedActions: (requested.plugins?.allowedActions ?? []).filter((action) => parent.plugins.allowedActions.includes(action)) },
    artifacts: { publishTaskIds: [taskId], allowedDestinations },
    tasks: { canCreate: false, visibleTaskIds: [taskId], canCancel: parent.tasks.canCancel, canFollowUp: parent.tasks.canFollowUp },
  };
}

export function attenuateWorker(task: CapabilitySet, requested: Partial<CapabilitySet>): CapabilitySet {
  return {
    memory: { allowedScopes: (requested.memory?.allowedScopes ?? []).filter((scope) => task.memory.allowedScopes.includes(scope)) },
    projects: (requested.projects ?? []).filter((item) => containsProject(task, item.projectId, item.access)),
    qq: {
      readConversations: (requested.qq?.readConversations ?? []).filter((id) => task.qq.readConversations.includes(id)),
      sendConversations: (requested.qq?.sendConversations ?? []).filter((id) => task.qq.sendConversations.includes(id)),
    },
    plugins: { allowedActions: (requested.plugins?.allowedActions ?? []).filter((action) => task.plugins.allowedActions.includes(action)) },
    artifacts: {
      publishTaskIds: (requested.artifacts?.publishTaskIds ?? []).filter((id) => task.artifacts.publishTaskIds.includes(id)),
      allowedDestinations: (requested.artifacts?.allowedDestinations ?? []).filter((id) => task.artifacts.allowedDestinations.includes(id)),
    },
    tasks: { canCreate: false, visibleTaskIds: [], canCancel: false, canFollowUp: false },
  };
}

export type AuthorizationDecision = { allowed: true } | { allowed: false; reason: "NOT_AUTHENTICATED" | "CAPABILITY_NOT_GRANTED" | "CONVERSATION_SCOPE_DENIED" | "RESOURCE_SCOPE_DENIED" | "PRIVILEGE_ESCALATION_DENIED" | "POLICY_DENIED"; resource?: string; operation?: string };

export function authorizeSend(caps: CapabilitySet, conversationId: string): AuthorizationDecision {
  return caps.qq.sendConversations.includes(conversationId)
    ? { allowed: true }
    : { allowed: false, reason: "CONVERSATION_SCOPE_DENIED", resource: conversationId, operation: "chat.send" };
}

export function authorizeMemory(caps: CapabilitySet, scope: MemoryScope): AuthorizationDecision {
  return caps.memory.allowedScopes.includes(scope)
    ? { allowed: true }
    : { allowed: false, reason: "RESOURCE_SCOPE_DENIED", resource: scope, operation: "memory.read" };
}
