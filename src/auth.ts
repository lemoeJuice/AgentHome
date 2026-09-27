import type { CapabilitySet, ConversationAddress, MemoryScope, RequesterContext, Trust } from "./shared/types.js";

export interface PluginCapabilityPolicy {
  allowedActions?: string[];
  allowedPermissions?: string[];
  guestAllowedActions?: string[];
  guestAllowedPermissions?: string[];
  guestTaskExecutionEnabled?: boolean;
}

export function deriveCapabilities(requester: RequesterContext, conversation: ConversationAddress, owner: { platform: string; accountId: string; userId: string } | undefined, conversationId: string, policy: PluginCapabilityPolicy = {}): CapabilitySet {
  const isOwnerIdentity = Boolean(owner && (
    (requester.platform === owner.platform && requester.accountId === owner.accountId && requester.userId === owner.userId)
    || requester.principalId === "principal:owner"
  ));
  const isOwner = requester.trust === "OWNER" && isOwnerIdentity;
  const trust: Trust = isOwner ? "OWNER" : "GUEST";
  const principalScope = requester.principalId ?? requester.userId;
  const baseScopes: MemoryScope[] = [`user:${principalScope}`];
  if (trust === "OWNER") baseScopes.push("global_agent");
  if (trust === "OWNER" && conversation.kind === "private") baseScopes.push("owner_private");
  const canCreate = trust === "OWNER" || policy.guestTaskExecutionEnabled === true;
  const allowedActions = trust === "OWNER" ? policy.allowedActions : policy.guestAllowedActions;
  const allowedPermissions = trust === "OWNER" ? policy.allowedPermissions : policy.guestAllowedPermissions;
  return {
    memory: { allowedScopes: baseScopes },
    // Requester permissions follow the authenticated identity. Conversation-scoped
    // Memory and chat destinations remain bounded separately below.
    projects: canCreate ? [{ projectId: "*", access: "WRITE" }] : [],
    qq: { readConversations: [conversationId], sendConversations: [conversationId] },
    plugins: { allowedActions: [...new Set(allowedActions ?? [])], ...(allowedPermissions ? { allowedPermissions: [...new Set(allowedPermissions)] } : {}) },
    artifacts: { readableArtifactAuthorities: ["agent-home"], publishTaskIds: canCreate ? ["*"] : [], allowedDestinations: [conversationId] },
    tasks: { canCreate, visibleTaskIds: [], canCancel: trust === "OWNER" || canCreate, canFollowUp: true },
  };
}

export function validateCapabilitySet(value: unknown): CapabilitySet {
  if (!value || typeof value !== "object") throw new Error("CAPABILITY_SNAPSHOT_INVALID");
  const input = value as Record<string, unknown>;
  const memory = input.memory as Record<string, unknown> | undefined;
  const projects = input.projects;
  const qq = input.qq as Record<string, unknown> | undefined;
  const plugins = input.plugins as Record<string, unknown> | undefined;
  const artifacts = input.artifacts as Record<string, unknown> | undefined;
  const tasks = input.tasks as Record<string, unknown> | undefined;
  const strings = (candidate: unknown, error: string): string[] => {
    if (!Array.isArray(candidate) || candidate.some((item) => typeof item !== "string" || !item)) throw new Error(error);
    return [...new Set(candidate)];
  };
  const allowedScopes = strings(memory?.allowedScopes, "CAPABILITY_MEMORY_INVALID").filter((scope): scope is MemoryScope => /^(global_agent|owner_private|user:[^\s]+|group:[^\s]+|project:[^\s]+)$/.test(scope));
  if (allowedScopes.length !== strings(memory?.allowedScopes, "CAPABILITY_MEMORY_INVALID").length) throw new Error("CAPABILITY_MEMORY_INVALID");
  if (!Array.isArray(projects) || projects.some((item) => !item || typeof item !== "object" || typeof (item as Record<string, unknown>).projectId !== "string" || !(item as Record<string, unknown>).projectId || !["READ", "WRITE"].includes(String((item as Record<string, unknown>).access)))) throw new Error("CAPABILITY_PROJECT_INVALID");
  const normalizedProjects = (projects as Array<Record<string, unknown>>).map((item) => ({ projectId: item.projectId as string, access: item.access as "READ" | "WRITE" }));
  const conversations = (candidate: unknown, error: string) => strings(candidate, error);
  if (!qq || !plugins || !artifacts || !tasks || typeof qq !== "object" || typeof plugins !== "object" || typeof artifacts !== "object" || typeof tasks !== "object") throw new Error("CAPABILITY_SNAPSHOT_INVALID");
  const booleans = (candidate: Record<string, unknown>, names: string[]) => names.map((name) => { if (typeof candidate[name] !== "boolean") throw new Error("CAPABILITY_BOOLEAN_INVALID"); return Boolean(candidate[name]); });
  const bools = booleans(tasks, ["canCreate", "canCancel", "canFollowUp"]);
  const canCreate = bools[0] === true; const canCancel = bools[1] === true; const canFollowUp = bools[2] === true;
  const allowedPermissions = plugins.allowedPermissions === undefined ? undefined : strings(plugins.allowedPermissions, "CAPABILITY_PLUGIN_INVALID");
  return {
    memory: { allowedScopes },
    projects: normalizedProjects,
    qq: { readConversations: conversations(qq.readConversations, "CAPABILITY_QQ_INVALID"), sendConversations: conversations(qq.sendConversations, "CAPABILITY_QQ_INVALID") },
    plugins: { allowedActions: conversations(plugins.allowedActions, "CAPABILITY_PLUGIN_INVALID"), ...(allowedPermissions !== undefined ? { allowedPermissions } : {}) },
    artifacts: { readableArtifactAuthorities: conversations(artifacts.readableArtifactAuthorities ?? [], "CAPABILITY_ARTIFACT_INVALID"), publishTaskIds: conversations(artifacts.publishTaskIds, "CAPABILITY_ARTIFACT_INVALID"), allowedDestinations: conversations(artifacts.allowedDestinations, "CAPABILITY_ARTIFACT_INVALID") },
    tasks: { canCreate, visibleTaskIds: conversations(tasks.visibleTaskIds, "CAPABILITY_TASK_INVALID"), canCancel, canFollowUp },
  };
}

export function capabilityWithin(child: CapabilitySet, parent: CapabilitySet): boolean {
  const projectWithin = child.projects.every((item) => containsProject(parent, item.projectId, item.access));
  const listWithin = (childValues: string[], parentValues: string[], parentUnrestricted = false) => parentUnrestricted || parentValues.includes("*") || childValues.every((value) => parentValues.includes(value));
  const childPermissions = child.plugins.allowedPermissions;
  const parentPermissions = parent.plugins.allowedPermissions;
  const permissionsWithin = parentPermissions === undefined
    ? true
    : childPermissions !== undefined && (parentPermissions.includes("*") || childPermissions.every((permission) => parentPermissions.includes(permission)));
  return child.memory.allowedScopes.every((scope) => parent.memory.allowedScopes.includes(scope))
    && projectWithin
    && listWithin(child.qq.readConversations, parent.qq.readConversations)
    && listWithin(child.qq.sendConversations, parent.qq.sendConversations)
    && listWithin(child.plugins.allowedActions, parent.plugins.allowedActions)
    && permissionsWithin
    && listWithin(child.artifacts.readableArtifactAuthorities, parent.artifacts.readableArtifactAuthorities)
    && listWithin(child.artifacts.allowedDestinations, parent.artifacts.allowedDestinations)
    && listWithin(child.artifacts.publishTaskIds, parent.artifacts.publishTaskIds, parent.tasks.canCreate)
    && listWithin(child.tasks.visibleTaskIds, parent.tasks.visibleTaskIds, parent.tasks.canCreate)
    && (!child.tasks.canCreate || parent.tasks.canCreate)
    && (!child.tasks.canCancel || parent.tasks.canCancel)
    && (!child.tasks.canFollowUp || parent.tasks.canFollowUp);
}

function containsProject(parent: CapabilitySet, projectId: string, access: "READ" | "WRITE"): boolean {
  return parent.projects.some((item) => (item.projectId === "*" || item.projectId === projectId) && (item.access === "WRITE" || item.access === access));
}

export type CapabilityRequestOperation = "task.create" | "worker.create";

export type CapabilityRequestDecision = {
  allowed: false;
  reason: "CAPABILITY_REQUEST_INVALID" | "PRIVILEGE_ESCALATION_DENIED";
  operation: CapabilityRequestOperation;
  resource: string;
};

export class CapabilityRequestDeniedError extends Error {
  readonly code = "CAPABILITY_REQUEST_DENIED";
  readonly decision: CapabilityRequestDecision;

  constructor(decision: CapabilityRequestDecision) {
    super(`${decision.reason}:${decision.operation}:${decision.resource}`);
    this.name = "CapabilityRequestDeniedError";
    this.decision = decision;
  }
}

function denyCapabilityRequest(operation: CapabilityRequestOperation, resource: string, reason: CapabilityRequestDecision["reason"] = "PRIVILEGE_ESCALATION_DENIED"): never {
  throw new CapabilityRequestDeniedError({ allowed: false, reason, operation, resource });
}

function requestObject(value: unknown, operation: CapabilityRequestOperation, resource: string): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) denyCapabilityRequest(operation, resource, "CAPABILITY_REQUEST_INVALID");
  return value as Record<string, unknown>;
}

function requestStrings(value: unknown, operation: CapabilityRequestOperation, resource: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item)) denyCapabilityRequest(operation, resource, "CAPABILITY_REQUEST_INVALID");
  return [...new Set(value as string[])];
}

function requestProjects(value: unknown, operation: CapabilityRequestOperation): Array<{ projectId: string; access: "READ" | "WRITE" }> {
  if (!Array.isArray(value)) denyCapabilityRequest(operation, "projects", "CAPABILITY_REQUEST_INVALID");
  return (value as unknown[]).map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) denyCapabilityRequest(operation, `projects[${index}]`, "CAPABILITY_REQUEST_INVALID");
    const project = item as Record<string, unknown>;
    if (typeof project.projectId !== "string" || !project.projectId || (project.access !== "READ" && project.access !== "WRITE")) denyCapabilityRequest(operation, `projects[${index}]`, "CAPABILITY_REQUEST_INVALID");
    return { projectId: project.projectId, access: project.access };
  });
}

function requestedSubset(values: string[], allowed: string[], operation: CapabilityRequestOperation, resource: string): string[] {
  if (allowed.includes("*")) return values;
  if (values.some((value) => !allowed.includes(value))) denyCapabilityRequest(operation, resource);
  return values;
}

function requestedProjects(values: Array<{ projectId: string; access: "READ" | "WRITE" }>, parent: CapabilitySet, operation: CapabilityRequestOperation): Array<{ projectId: string; access: "READ" | "WRITE" }> {
  if (values.some((value) => !containsProject(parent, value.projectId, value.access))) denyCapabilityRequest(operation, "projects");
  return values;
}

export function attenuateTask(parent: CapabilitySet, requested: Partial<CapabilitySet>, taskId: string): CapabilitySet {
  const checkedParent = validateCapabilitySet(parent);
  const operation: CapabilityRequestOperation = "task.create";
  if (!checkedParent.tasks.canCreate) denyCapabilityRequest(operation, "tasks.canCreate");
  const input = requestObject(requested, operation, "capabilities") ?? {};
  const memoryRequest = requestObject(input.memory, operation, "memory");
  const projects = input.projects === undefined
    ? checkedParent.projects
    : requestedProjects(requestProjects(input.projects, operation), checkedParent, operation);
  const memory = memoryRequest?.allowedScopes === undefined
    ? checkedParent.memory.allowedScopes
    : requestedSubset(requestStrings(memoryRequest.allowedScopes, operation, "memory.allowedScopes"), checkedParent.memory.allowedScopes, operation, "memory.allowedScopes") as MemoryScope[];
  const qqRequest = requestObject(input.qq, operation, "qq");
  const readConversations = qqRequest?.readConversations === undefined
    ? checkedParent.qq.readConversations
    : requestedSubset(requestStrings(qqRequest.readConversations, operation, "qq.readConversations"), checkedParent.qq.readConversations, operation, "qq.readConversations");
  const sendConversations = qqRequest?.sendConversations === undefined
    ? checkedParent.qq.sendConversations
    : requestedSubset(requestStrings(qqRequest.sendConversations, operation, "qq.sendConversations"), checkedParent.qq.sendConversations, operation, "qq.sendConversations");
  const pluginRequest = requestObject(input.plugins, operation, "plugins");
  const allowedActions = pluginRequest?.allowedActions === undefined
    ? []
    : requestedSubset(requestStrings(pluginRequest.allowedActions, operation, "plugins.allowedActions"), checkedParent.plugins.allowedActions, operation, "plugins.allowedActions");
  const requestedPermissions = pluginRequest?.allowedPermissions;
  const allowedPermissions = requestedPermissions === undefined
    ? checkedParent.plugins.allowedPermissions
    : checkedParent.plugins.allowedPermissions === undefined
      ? requestStrings(requestedPermissions, operation, "plugins.allowedPermissions")
      : requestedSubset(requestStrings(requestedPermissions, operation, "plugins.allowedPermissions"), checkedParent.plugins.allowedPermissions, operation, "plugins.allowedPermissions");
  const artifactRequest = requestObject(input.artifacts, operation, "artifacts");
  const readableArtifactAuthorities = artifactRequest?.readableArtifactAuthorities === undefined
    ? checkedParent.artifacts.readableArtifactAuthorities
    : requestedSubset(requestStrings(artifactRequest.readableArtifactAuthorities, operation, "artifacts.readableArtifactAuthorities"), checkedParent.artifacts.readableArtifactAuthorities, operation, "artifacts.readableArtifactAuthorities");
  const allowedDestinations = artifactRequest?.allowedDestinations === undefined
    ? checkedParent.artifacts.allowedDestinations
    : requestedSubset(requestStrings(artifactRequest.allowedDestinations, operation, "artifacts.allowedDestinations"), checkedParent.artifacts.allowedDestinations, operation, "artifacts.allowedDestinations");
  const requestedPublishTaskIds = artifactRequest?.publishTaskIds === undefined
    ? undefined
    : requestStrings(artifactRequest.publishTaskIds, operation, "artifacts.publishTaskIds");
  const publishTaskIds = requestedPublishTaskIds === undefined
    ? (checkedParent.artifacts.publishTaskIds.includes("*") || checkedParent.artifacts.publishTaskIds.includes(taskId) ? [taskId] : [])
    : requestedPublishTaskIds;
  if (publishTaskIds.some((id) => id !== taskId) || publishTaskIds.some((id) => !checkedParent.artifacts.publishTaskIds.includes("*") && !checkedParent.artifacts.publishTaskIds.includes(id))) denyCapabilityRequest(operation, "artifacts.publishTaskIds");
  const taskRequest = requestObject(input.tasks, operation, "tasks");
  const canCreate = taskRequest?.canCreate === undefined ? false : taskRequest.canCreate;
  if (typeof canCreate !== "boolean") denyCapabilityRequest(operation, "tasks.canCreate", "CAPABILITY_REQUEST_INVALID");
  if (canCreate) denyCapabilityRequest(operation, "tasks.canCreate");
  const visibleTaskIds = taskRequest?.visibleTaskIds === undefined
    ? [taskId]
    : requestStrings(taskRequest.visibleTaskIds, operation, "tasks.visibleTaskIds");
  if (visibleTaskIds.some((id) => id !== taskId)) denyCapabilityRequest(operation, "tasks.visibleTaskIds");
  const canCancel = taskRequest?.canCancel === undefined ? checkedParent.tasks.canCancel : taskRequest.canCancel;
  if (typeof canCancel !== "boolean") denyCapabilityRequest(operation, "tasks.canCancel", "CAPABILITY_REQUEST_INVALID");
  if (canCancel && !checkedParent.tasks.canCancel) denyCapabilityRequest(operation, "tasks.canCancel");
  const canFollowUp = taskRequest?.canFollowUp === undefined ? checkedParent.tasks.canFollowUp : taskRequest.canFollowUp;
  if (typeof canFollowUp !== "boolean") denyCapabilityRequest(operation, "tasks.canFollowUp", "CAPABILITY_REQUEST_INVALID");
  if (canFollowUp && !checkedParent.tasks.canFollowUp) denyCapabilityRequest(operation, "tasks.canFollowUp");
  return {
    memory: { allowedScopes: memory }, projects, qq: { readConversations, sendConversations },
    plugins: { allowedActions, ...(allowedPermissions !== undefined ? { allowedPermissions } : {}) },
    artifacts: { readableArtifactAuthorities, publishTaskIds, allowedDestinations },
    tasks: { canCreate: false, visibleTaskIds, canCancel, canFollowUp },
  };
}

export function attenuateWorker(task: CapabilitySet, requested: Partial<CapabilitySet>): CapabilitySet {
  const checkedTask = validateCapabilitySet(task);
  const operation: CapabilityRequestOperation = "worker.create";
  const input = requestObject(requested, operation, "capabilities") ?? {};
  const memoryRequest = requestObject(input.memory, operation, "memory");
  const memory = memoryRequest?.allowedScopes === undefined
    ? []
    : requestedSubset(requestStrings(memoryRequest.allowedScopes, operation, "memory.allowedScopes"), checkedTask.memory.allowedScopes, operation, "memory.allowedScopes") as MemoryScope[];
  const projects = input.projects === undefined
    ? []
    : requestedProjects(requestProjects(input.projects, operation), checkedTask, operation);
  const qqRequest = requestObject(input.qq, operation, "qq");
  const readConversations = qqRequest?.readConversations === undefined
    ? []
    : requestedSubset(requestStrings(qqRequest.readConversations, operation, "qq.readConversations"), checkedTask.qq.readConversations, operation, "qq.readConversations");
  const sendConversations = qqRequest?.sendConversations === undefined
    ? []
    : requestedSubset(requestStrings(qqRequest.sendConversations, operation, "qq.sendConversations"), checkedTask.qq.sendConversations, operation, "qq.sendConversations");
  const pluginRequest = requestObject(input.plugins, operation, "plugins");
  const allowedActions = pluginRequest?.allowedActions === undefined
    ? []
    : requestedSubset(requestStrings(pluginRequest.allowedActions, operation, "plugins.allowedActions"), checkedTask.plugins.allowedActions, operation, "plugins.allowedActions");
  const requestedPermissions = pluginRequest?.allowedPermissions;
  const allowedPermissions = requestedPermissions === undefined
    ? checkedTask.plugins.allowedPermissions
    : checkedTask.plugins.allowedPermissions === undefined
      ? requestStrings(requestedPermissions, operation, "plugins.allowedPermissions")
      : requestedSubset(requestStrings(requestedPermissions, operation, "plugins.allowedPermissions"), checkedTask.plugins.allowedPermissions, operation, "plugins.allowedPermissions");
  const artifactRequest = requestObject(input.artifacts, operation, "artifacts");
  const readableArtifactAuthorities = artifactRequest?.readableArtifactAuthorities === undefined
    ? []
    : requestedSubset(requestStrings(artifactRequest.readableArtifactAuthorities, operation, "artifacts.readableArtifactAuthorities"), checkedTask.artifacts.readableArtifactAuthorities, operation, "artifacts.readableArtifactAuthorities");
  const publishTaskIds = artifactRequest?.publishTaskIds === undefined
    ? []
    : requestedSubset(requestStrings(artifactRequest.publishTaskIds, operation, "artifacts.publishTaskIds"), checkedTask.artifacts.publishTaskIds, operation, "artifacts.publishTaskIds");
  const allowedDestinations = artifactRequest?.allowedDestinations === undefined
    ? []
    : requestedSubset(requestStrings(artifactRequest.allowedDestinations, operation, "artifacts.allowedDestinations"), checkedTask.artifacts.allowedDestinations, operation, "artifacts.allowedDestinations");
  const taskRequest = requestObject(input.tasks, operation, "tasks");
  if (taskRequest) {
    const canCreate = taskRequest.canCreate;
    const canCancel = taskRequest.canCancel;
    const canFollowUp = taskRequest.canFollowUp;
    if (canCreate !== undefined && canCreate !== false) denyCapabilityRequest(operation, "tasks.canCreate");
    if (canCancel !== undefined && canCancel !== false) denyCapabilityRequest(operation, "tasks.canCancel");
    if (canFollowUp !== undefined && canFollowUp !== false) denyCapabilityRequest(operation, "tasks.canFollowUp");
    if (taskRequest.visibleTaskIds !== undefined && requestStrings(taskRequest.visibleTaskIds, operation, "tasks.visibleTaskIds").length > 0) denyCapabilityRequest(operation, "tasks.visibleTaskIds");
    for (const [name, value] of [["canCreate", canCreate], ["canCancel", canCancel], ["canFollowUp", canFollowUp]] as const) {
      if (value !== undefined && typeof value !== "boolean") denyCapabilityRequest(operation, `tasks.${name}`, "CAPABILITY_REQUEST_INVALID");
    }
  }
  return {
    memory: { allowedScopes: memory },
    projects,
    qq: {
      readConversations,
      sendConversations,
    },
    plugins: { allowedActions, ...(allowedPermissions !== undefined ? { allowedPermissions } : {}) },
    artifacts: {
      readableArtifactAuthorities,
      publishTaskIds,
      allowedDestinations,
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

export function authorizeRead(caps: CapabilitySet, conversationId: string): AuthorizationDecision {
  return caps.qq.readConversations.includes(conversationId)
    ? { allowed: true }
    : { allowed: false, reason: "CONVERSATION_SCOPE_DENIED", resource: conversationId, operation: "chat.read" };
}

export function authorizeMemory(caps: CapabilitySet, scope: MemoryScope): AuthorizationDecision {
  return caps.memory.allowedScopes.includes(scope)
    ? { allowed: true }
    : { allowed: false, reason: "RESOURCE_SCOPE_DENIED", resource: scope, operation: "memory.read" };
}
