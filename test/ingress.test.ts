import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeApp } from "../src/runtime/runtime.js";
import { deriveCapabilities } from "../src/auth.js";
import type { AppConfig } from "../src/config.js";
import type { Logger } from "../src/shared/logger.js";
import type { CapabilitySet, ConversationAddress, PlatformMessageRef } from "../src/shared/types.js";

const logger = { child: () => logger, info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger;

test("runtime ingress is enqueue-before-ACK and deduplicated", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-home-runtime-"));
  const config = { instanceId: "test", owner: { platform: "qq", accountId: "a", userId: "owner" }, paths: { gatewayState: join(root, "gateway.sqlite"), pluginData: join(root, "plugins"), backupDir: join(root, "backups"), stateRoot: root, runtimeSocket: join(root, "run.sock") }, snowluma: { accountId: "a", endpoint: "ws://127.0.0.1:1", apiEndpoint: "http://127.0.0.1:1", accessTokenEnv: "NO_TOKEN", reverseWebSocketPath: "/ws", reconnectMs: 10, requestTimeoutMs: 10 }, chat: { global: { commandRequireMention: false, naturalLanguageMode: "explicit_wake" }, qq: { commandRequireMention: false, naturalLanguageMode: "explicit_wake" }, conversationOverrides: {} }, runtime: { maxInFlight: 2, maxWorkers: 1, maxArtifactBytes: 100000, piCommand: "missing-pi", piTimeoutMs: 100 }, plugins: { enabled: [] }, logging: { level: "error" } } as AppConfig;
  const runtime = new RuntimeApp(config, logger);
  const event = { protocolVersion: 1 as const, eventId: "evt-1", instanceId: "test", type: "chat.message" as const, occurredAt: new Date().toISOString(), source: { platform: "qq", accountId: "a", adapter: "test" }, trustedIdentity: { userId: "owner" }, conversation: { conversationId: "external", address: { platform: "qq", accountId: "a", kind: "private" as const, platformConversationId: "owner", threadId: null } }, message: { ref: { platform: "qq", accountId: "a", platformConversationId: "owner", threadId: null, messageId: "m" }, replyTo: null }, payload: { text: "hello", attachments: [], rawSegments: [] } };
  const first = await runtime.receive(event);
  const second = await runtime.receive(event);
  assert.equal(first.status, "accepted");
  assert.equal(second.status, "duplicate");
  assert.ok(["PENDING", "PROCESSING", "DONE", "FAILED"].includes(runtime.db.get<{ status: string }>("SELECT status FROM ingress_events WHERE event_id='evt-1'")?.status ?? ""));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(runtime.db.get<{ trust: string }>("SELECT trust FROM principals LIMIT 1")?.trust, "OWNER");
  assert.equal(runtime.db.get<{ principal_id: string }>("SELECT principal_id FROM platform_identities WHERE user_id='owner'")?.principal_id, "principal:owner");
  await runtime.stop();
  await rm(root, { recursive: true, force: true });
});

test("principal binding is explicit and group scope stays separate from Owner requester trust", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-home-principal-binding-"));
  const config = { instanceId: "principal-binding", owner: { platform: "qq", accountId: "a", userId: "owner" }, paths: { gatewayState: join(root, "gateway.sqlite"), pluginData: join(root, "plugins"), backupDir: join(root, "backups"), stateRoot: root, runtimeSocket: join(root, "run.sock") }, snowluma: { accountId: "a", endpoint: "ws://127.0.0.1:1", apiEndpoint: "http://127.0.0.1:1", accessTokenEnv: "NO_TOKEN", reverseWebSocketPath: "/ws", reconnectMs: 10, requestTimeoutMs: 10 }, chat: { global: { commandRequireMention: false, naturalLanguageMode: "explicit_wake" }, qq: { commandRequireMention: false, naturalLanguageMode: "explicit_wake" }, conversationOverrides: {} }, runtime: { maxInFlight: 2, maxWorkers: 1, maxArtifactBytes: 100000, piCommand: "missing-pi", piTimeoutMs: 100 }, plugins: { enabled: [] }, logging: { level: "error" } } as AppConfig;
  const runtime = new RuntimeApp(config, logger);
  const internals = runtime as unknown as {
    resolvePrincipalIdentity: (platform: string, accountId: string, userId: string) => { principalId: string; trust: "OWNER" | "GUEST" };
    bindPlatformIdentity: (actor: { platform: string; accountId: string; userId: string }, target: { platform: string; accountId: string; userId: string }) => void;
    unbindPlatformIdentity: (actor: { platform: string; accountId: string; userId: string }, target: { platform: string; accountId: string; userId: string }) => void;
    getOrCreateConversation: (value: ConversationAddress, principal: { principalId: string; trust: "OWNER" | "GUEST" }) => { id: string; address: ConversationAddress; principalId: string; trust: "OWNER" | "GUEST" };
  };
  try {
    const guest = internals.resolvePrincipalIdentity("telegram", "bot-b", "user-1");
    assert.equal(guest.trust, "GUEST");
    assert.notEqual(guest.principalId, "principal:owner");
    assert.throws(() => internals.bindPlatformIdentity({ platform: "telegram", accountId: "bot-b", userId: "user-1" }, { platform: "telegram", accountId: "bot-b", userId: "user-2" }), /IDENTITY_BINDING_DENIED/);

    internals.bindPlatformIdentity({ platform: "qq", accountId: "a", userId: "owner" }, { platform: "telegram", accountId: "bot-b", userId: "user-1" });
    const bound = internals.resolvePrincipalIdentity("telegram", "bot-b", "user-1");
    assert.deepEqual(bound, { principalId: "principal:owner", trust: "OWNER" });
    internals.unbindPlatformIdentity({ platform: "qq", accountId: "a", userId: "owner" }, { platform: "telegram", accountId: "bot-b", userId: "user-1" });
    const unbound = internals.resolvePrincipalIdentity("telegram", "bot-b", "user-1");
    assert.equal(unbound.trust, "GUEST");
    assert.notEqual(unbound.principalId, "principal:owner");
    assert.throws(() => internals.unbindPlatformIdentity({ platform: "qq", accountId: "a", userId: "owner" }, { platform: "qq", accountId: "a", userId: "owner" }), /OWNER_IDENTITY_CANNOT_UNBIND/);

    const owner = internals.resolvePrincipalIdentity("qq", "a", "owner");
    const groupAddress: ConversationAddress = { platform: "qq", accountId: "a", kind: "group", platformConversationId: "group-1", threadId: null };
    const group = internals.getOrCreateConversation(groupAddress, owner);
    assert.equal(owner.trust, "OWNER");
    assert.equal(group.trust, "GUEST");
    const groupCaps = deriveCapabilities({ platform: "qq", accountId: "a", userId: "owner", principalId: owner.principalId, trust: owner.trust, conversationId: group.id }, groupAddress, config.owner, group.id);
    assert.equal(groupCaps.tasks.canCreate, false);
    assert.equal(groupCaps.memory.allowedScopes.includes("owner_private"), false);
  } finally {
    await runtime.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime control socket is private and rejects unauthenticated peers", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-home-runtime-auth-"));
  const socketPath = join(root, "run.sock");
  const config = { instanceId: "test-auth", owner: { platform: "qq", accountId: "a", userId: "owner" }, paths: { gatewayState: join(root, "gateway.sqlite"), pluginData: join(root, "plugins"), backupDir: join(root, "backups"), stateRoot: root, runtimeSocket: socketPath }, snowluma: { accountId: "a", endpoint: "ws://127.0.0.1:1", apiEndpoint: "http://127.0.0.1:1", accessTokenEnv: "NO_TOKEN", reverseWebSocketPath: "/ws", reconnectMs: 10, requestTimeoutMs: 10 }, chat: { global: { commandRequireMention: false, naturalLanguageMode: "explicit_wake" }, qq: { commandRequireMention: false, naturalLanguageMode: "explicit_wake" }, conversationOverrides: {} }, runtime: { maxInFlight: 2, maxWorkers: 1, maxArtifactBytes: 100000, piCommand: "missing-pi", piTimeoutMs: 100 }, plugins: { enabled: [] }, logging: { level: "error" } } as AppConfig;
  const previous = process.env.AGENT_HOME_CONTROL_TOKEN;
  process.env.AGENT_HOME_CONTROL_TOKEN = "test-control-token";
  const runtime = new RuntimeApp(config, logger);
  try {
    await runtime.start();
    assert.equal((await stat(socketPath)).mode & 0o777, 0o600);
    const response = await new Promise<string>((resolve, reject) => {
      const socket = createConnection(socketPath);
      let data = "";
      socket.once("error", reject);
      socket.on("data", (chunk) => { data += String(chunk); if (data.includes("\n")) { socket.destroy(); resolve(data); } });
      socket.once("connect", () => socket.write('{"type":"hello","protocolVersion":1,"controlToken":"wrong"}\n'));
    });
    assert.match(response, /CONTROL_AUTH_FAILED/);
  } finally {
    await runtime.stop();
    if (previous === undefined) delete process.env.AGENT_HOME_CONTROL_TOKEN; else process.env.AGENT_HOME_CONTROL_TOKEN = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("main turns are durable and serialized per conversation", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-home-main-queue-"));
  const config = { instanceId: "main-queue", owner: { platform: "qq", accountId: "a", userId: "owner" }, paths: { gatewayState: join(root, "gateway.sqlite"), pluginData: join(root, "plugins"), backupDir: join(root, "backups"), stateRoot: root, runtimeSocket: join(root, "run.sock") }, snowluma: { accountId: "a", endpoint: "ws://127.0.0.1:1", apiEndpoint: "http://127.0.0.1:1", accessTokenEnv: "NO_TOKEN", reverseWebSocketPath: "/ws", reconnectMs: 10, requestTimeoutMs: 10 }, chat: { global: { commandRequireMention: false, naturalLanguageMode: "explicit_wake" }, qq: { commandRequireMention: false, naturalLanguageMode: "explicit_wake" }, conversationOverrides: {} }, runtime: { maxInFlight: 2, maxWorkers: 1, maxArtifactBytes: 100000, piCommand: "missing-pi", piTimeoutMs: 100 }, plugins: { enabled: [] }, logging: { level: "error" } } as AppConfig;
  const runtime = new RuntimeApp(config, logger);
  const prompts: string[] = [];
  let activeTurns = 0;
  let maxActiveTurns = 0;
  const internals = runtime as unknown as { pi: { createSession: (path: string) => Promise<{ sessionId: string; sessionPath: string }>; send: (session: { sessionId: string; sessionPath: string }, prompt: string) => Promise<string>; stop: () => Promise<void> }; qq: { sendMessage: (target: unknown, message: { text: string }) => Promise<unknown> } };
  internals.pi = { createSession: async (path) => ({ sessionId: `main-session-${path}`, sessionPath: path }), send: async (_session, prompt) => { prompts.push(prompt); activeTurns += 1; maxActiveTurns = Math.max(maxActiveTurns, activeTurns); await new Promise((resolve) => setTimeout(resolve, 10)); activeTurns -= 1; return `response-${prompts.length}`; }, stop: async () => {} };
  internals.qq = { sendMessage: async (_target, message) => ({ message: { platform: "qq", accountId: "a", platformConversationId: "owner", threadId: null, messageId: `out-${prompts.length}` }, accepted: true, echoedText: message.text }) };
  const event = (eventId: string, text: string, group = false) => ({ protocolVersion: 1 as const, eventId, instanceId: "main-queue", type: "chat.message" as const, occurredAt: new Date().toISOString(), source: { platform: "qq", accountId: "a", adapter: "test" }, trustedIdentity: { userId: group ? "guest" : "owner" }, conversation: { conversationId: "external", address: { platform: "qq", accountId: "a", kind: group ? "group" as const : "private" as const, platformConversationId: group ? "group-1" : "owner", threadId: null } }, message: { ref: { platform: "qq", accountId: "a", platformConversationId: group ? "group-1" : "owner", threadId: null, messageId: eventId }, replyTo: null }, payload: { text, attachments: [], rawSegments: [] } });
  try {
    await runtime.start();
    await runtime.receive(event("main-1", "first message"));
    await runtime.receive(event("main-2", "second message"));
    await runtime.receive(event("main-3", "group message", true));
    for (let index = 0; index < 100 && runtime.db.get<{ count: number }>("SELECT count(*) AS count FROM main_turn_queue WHERE status='DONE'")?.count !== 3; index += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(prompts.filter((prompt) => prompt.includes("first message")).length, 1);
    assert.equal(prompts.filter((prompt) => prompt.includes("second message")).length, 1);
    assert.ok(prompts.findIndex((prompt) => prompt.includes("first message")) < prompts.findIndex((prompt) => prompt.includes("second message")));
    assert.ok(maxActiveTurns >= 2);
    assert.equal(runtime.db.get<{ count: number }>("SELECT count(*) AS count FROM main_turn_queue WHERE status='DONE'")?.count, 3);
  } finally {
    await runtime.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime outbound intents recover after failed delivery", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-home-outbound-"));
  const config = { instanceId: "outbound", owner: { platform: "qq", accountId: "a", userId: "owner" }, paths: { gatewayState: join(root, "gateway.sqlite"), pluginData: join(root, "plugins"), backupDir: join(root, "backups"), stateRoot: root, runtimeSocket: join(root, "run.sock") }, snowluma: { accountId: "a", endpoint: "ws://127.0.0.1:1", apiEndpoint: "http://127.0.0.1:1", accessTokenEnv: "NO_TOKEN", reverseWebSocketPath: "/ws", reconnectMs: 10, requestTimeoutMs: 10 }, chat: { global: { commandRequireMention: false, naturalLanguageMode: "explicit_wake" }, qq: { commandRequireMention: false, naturalLanguageMode: "explicit_wake" }, conversationOverrides: {} }, runtime: { maxInFlight: 2, maxWorkers: 1, maxArtifactBytes: 100000, piCommand: "missing-pi", piTimeoutMs: 100 }, plugins: { enabled: [] }, logging: { level: "error" } } as AppConfig;
  const event = { protocolVersion: 1 as const, eventId: "outbound-1", instanceId: "outbound", type: "chat.message" as const, occurredAt: new Date().toISOString(), source: { platform: "qq", accountId: "a", adapter: "test" }, trustedIdentity: { userId: "owner" }, conversation: { conversationId: "external", address: { platform: "qq", accountId: "a", kind: "private" as const, platformConversationId: "owner", threadId: null } }, message: { ref: { platform: "qq", accountId: "a", platformConversationId: "owner", threadId: null, messageId: "outbound-1" }, replyTo: null }, payload: { text: "first message", attachments: [], rawSegments: [] } };
  const installFakes = (runtime: RuntimeApp, fail: boolean) => {
    const internals = runtime as unknown as { pi: { createSession: (path: string) => Promise<{ sessionId: string; sessionPath: string }>; send: () => Promise<string>; stop: () => Promise<void> }; qq: { sendMessage: () => Promise<unknown> } };
    internals.pi = { createSession: async (path) => ({ sessionId: "main-session", sessionPath: path }), send: async () => "response", stop: async () => {} };
    internals.qq = { sendMessage: async () => { if (fail) throw new Error("DELIVERY_FAILED"); return { message: { platform: "qq", accountId: "a", platformConversationId: "owner", threadId: null, messageId: "outbound-reply" }, accepted: true }; } };
  };
  const first = new RuntimeApp(config, logger); installFakes(first, true);
  try {
    await first.start(); await first.receive(event);
    for (let index = 0; index < 100 && (first.db.get<{ count: number }>("SELECT count(*) AS count FROM runtime_outbound_intents WHERE status='PENDING'")?.count ?? 0) < 2; index += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(first.db.get<{ count: number }>("SELECT count(*) AS count FROM runtime_outbound_intents WHERE status='PENDING'")?.count, 2, JSON.stringify({ intents: first.db.all("SELECT id,status,last_error FROM runtime_outbound_intents"), queue: first.db.all("SELECT id,status,error FROM main_turn_queue") }));
    first.db.run("UPDATE runtime_outbound_intents SET status='DELIVERING',lease_until=?", "2020-01-01T00:00:00.000Z");
  } finally { await first.stop(); }
  const second = new RuntimeApp(config, logger); installFakes(second, false);
  try {
    await second.start();
    assert.equal(second.db.get<{ count: number }>("SELECT count(*) AS count FROM runtime_outbound_intents WHERE status='ACKED'")?.count, 2, JSON.stringify(second.db.all("SELECT id,status,attempts,last_error,lease_until FROM runtime_outbound_intents")));
  } finally { await second.stop(); await rm(root, { recursive: true, force: true }); }
});

test("Main lazy QQ tools enforce the current conversation read capability", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-home-main-qq-tools-"));
  const config = { instanceId: "main-qq-tools", owner: { platform: "qq", accountId: "a", userId: "owner" }, paths: { gatewayState: join(root, "gateway.sqlite"), pluginData: join(root, "plugins"), backupDir: join(root, "backups"), stateRoot: root, runtimeSocket: join(root, "run.sock") }, snowluma: { accountId: "a", endpoint: "ws://127.0.0.1:1", apiEndpoint: "http://127.0.0.1:1", accessTokenEnv: "NO_TOKEN", reverseWebSocketPath: "/ws", reconnectMs: 10, requestTimeoutMs: 10 }, chat: { global: { commandRequireMention: false, naturalLanguageMode: "explicit_wake" }, qq: { commandRequireMention: false, naturalLanguageMode: "explicit_wake" }, conversationOverrides: {} }, runtime: { maxInFlight: 2, maxWorkers: 1, maxArtifactBytes: 100000, piCommand: "missing-pi", piTimeoutMs: 100 }, plugins: { enabled: [] }, logging: { level: "error" } } as AppConfig;
  const runtime = new RuntimeApp(config, logger);
  const address: ConversationAddress = { platform: "qq", accountId: "a", kind: "group", platformConversationId: "group-1", threadId: null };
  const otherAddress: ConversationAddress = { ...address, platformConversationId: "group-2" };
  const ref: PlatformMessageRef = { platform: "qq", accountId: "a", platformConversationId: "group-1", threadId: null, messageId: "42" };
  const internals = runtime as unknown as {
    getOrCreateConversation: (value: ConversationAddress, principal: { principalId: string; trust: "OWNER" | "GUEST" }) => { id: string; address: ConversationAddress; trust: "OWNER" | "GUEST" };
    handleMainTool: (action: string, input: unknown, context: unknown) => Promise<unknown>;
    qq: { getMessage: (value: PlatformMessageRef) => Promise<unknown>; getHistory: (query: unknown) => Promise<unknown> };
  };
  const conversation = internals.getOrCreateConversation(address, { principalId: "principal:test", trust: "OWNER" });
  internals.getOrCreateConversation(otherAddress, { principalId: "principal:other", trust: "GUEST" });
  internals.qq = {
    getMessage: async (value) => ({ ref: value, payload: { text: "authorized" } }),
    getHistory: async (query) => [{ query, payload: { text: "history" } }],
  };
  const capabilities = {
    memory: { allowedScopes: ["global_agent"] }, projects: [], qq: { readConversations: [conversation.id], sendConversations: [conversation.id] }, plugins: { allowedActions: [] }, artifacts: { readableArtifactAuthorities: ["agent-home"], publishTaskIds: [], allowedDestinations: [conversation.id] }, tasks: { canCreate: true, visibleTaskIds: [], canCancel: true, canFollowUp: true },
  } as CapabilitySet;
   const context = { conversationId: conversation.id, requesterId: "owner", requester: { platform: "qq", accountId: "a", userId: "owner" }, trust: "OWNER", address, capabilities, eventId: "artifact-event", message: ref, replyTo: { ...ref, messageId: "7" } };
  try {
    const artifact = await runtime.artifacts.ingestAttachment({ stream: (async function* () { yield Buffer.from("authorized artifact"); })(), filename: "note.txt", mime: "text/plain", conversationId: conversation.id, requesterId: "owner", eventId: "artifact-event", maxBytes: 1000 });
    assert.deepEqual(await internals.handleMainTool("get_message", { ref }, context), { ref, payload: { text: "authorized" } });
    assert.deepEqual(await internals.handleMainTool("get_reply_context", {}, context), { ref: { ...ref, messageId: "7" }, payload: { text: "authorized" } });
    assert.equal((await internals.handleMainTool("read_artifact", { ref: artifact.ref }, context) as { content: string }).content, "authorized artifact");
    const history = await internals.handleMainTool("get_history", { limit: 3 }, context) as Array<{ query: { limit: number } }>;
    assert.equal(history[0]?.query.limit, 3);
    await assert.rejects(() => internals.handleMainTool("get_message", { ref: { ...ref, platformConversationId: "group-2" } }, context), /QQ_READ_DENIED/);
    await assert.rejects(() => internals.handleMainTool("read_artifact", { ref: artifact.ref }, { ...context, conversationId: "other-conversation" }), /ARTIFACT_CONVERSATION_READ_DENIED/);
    await assert.rejects(() => internals.handleMainTool("get_history", {}, { ...context, address: { ...address, kind: "private", platformConversationId: "owner" } }), /QQ_HISTORY_NOT_IMPLEMENTED/);
  } finally {
    await runtime.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime backup quiesce blocks intake until finish", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-home-backup-quiesce-"));
  const config = { instanceId: "backup-quiesce", owner: { platform: "qq", accountId: "a", userId: "owner" }, paths: { gatewayState: join(root, "gateway.sqlite"), pluginData: join(root, "plugins"), backupDir: join(root, "backups"), stateRoot: root, runtimeSocket: join(root, "run.sock") }, snowluma: { accountId: "a", endpoint: "ws://127.0.0.1:1", apiEndpoint: "http://127.0.0.1:1", accessTokenEnv: "NO_TOKEN", reverseWebSocketPath: "/ws", reconnectMs: 10, requestTimeoutMs: 10 }, chat: { global: { commandRequireMention: false, naturalLanguageMode: "explicit_wake" }, qq: { commandRequireMention: false, naturalLanguageMode: "explicit_wake" }, conversationOverrides: {} }, runtime: { maxInFlight: 2, maxWorkers: 1, maxArtifactBytes: 100000, piCommand: "missing-pi", piTimeoutMs: 100 }, plugins: { enabled: [] }, logging: { level: "error" } } as AppConfig;
  const event = { protocolVersion: 1 as const, eventId: "backup-event", instanceId: "backup-quiesce", type: "chat.message" as const, occurredAt: new Date().toISOString(), source: { platform: "qq", accountId: "a", adapter: "test" }, trustedIdentity: { userId: "owner" }, conversation: { conversationId: "external", address: { platform: "qq", accountId: "a", kind: "private" as const, platformConversationId: "owner", threadId: null } }, message: { ref: { platform: "qq", accountId: "a", platformConversationId: "owner", threadId: null, messageId: "backup-message" }, replyTo: null }, payload: { text: "backup" } };
  const first = new RuntimeApp(config, logger);
  try {
    await first.start();
    assert.deepEqual(await first.backupPrepare(), { status: "quiesced" });
    assert.equal((await first.receive(event)).errorCode, "RUNTIME_QUIESCED");
    assert.deepEqual(await first.backupFinish(), { status: "running" });
    assert.equal((await first.receive(event)).status, "accepted");
  } finally { await first.stop(); }
  const second = new RuntimeApp(config, logger);
  try {
    await second.start();
    assert.equal((await second.receive({ ...event, eventId: "backup-event-2" })).status, "accepted");
  } finally { await second.stop(); await rm(root, { recursive: true, force: true }); }
});

test("task replay refuses a notification destination outside its persisted capability", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-home-task-notification-"));
  const config = { instanceId: "task-notification", owner: { platform: "qq", accountId: "a", userId: "owner" }, paths: { gatewayState: join(root, "gateway.sqlite"), pluginData: join(root, "plugins"), backupDir: join(root, "backups"), stateRoot: root, runtimeSocket: join(root, "run.sock") }, snowluma: { accountId: "a", endpoint: "ws://127.0.0.1:1", apiEndpoint: "http://127.0.0.1:1", accessTokenEnv: "NO_TOKEN", reverseWebSocketPath: "/ws", reconnectMs: 10, requestTimeoutMs: 10 }, chat: { global: { commandRequireMention: false, naturalLanguageMode: "explicit_wake" }, qq: { commandRequireMention: false, naturalLanguageMode: "explicit_wake" }, conversationOverrides: {} }, runtime: { maxInFlight: 2, maxWorkers: 1, maxArtifactBytes: 100000, piCommand: "missing-pi", piTimeoutMs: 100 }, plugins: { enabled: [] }, logging: { level: "error" } } as AppConfig;
  const runtime = new RuntimeApp(config, logger);
  const internals = runtime as unknown as { onTaskEvent: (event: unknown, task: unknown) => Promise<void> };
  const caps = { memory: { allowedScopes: ["global_agent"] }, projects: [], qq: { readConversations: ["allowed"], sendConversations: ["allowed"] }, plugins: { allowedActions: [] }, artifacts: { readableArtifactAuthorities: ["agent-home"], publishTaskIds: [], allowedDestinations: ["allowed"] }, tasks: { canCreate: true, visibleTaskIds: [], canCancel: true, canFollowUp: true } };
  const task = runtime.tasks.createTask({ title: "notification", goal: "notification", requester: { platform: "qq", accountId: "a", userId: "owner" }, trust: "OWNER", originConversationId: "allowed", notificationConversationId: "allowed", parentCapabilities: caps });
  runtime.db.run("UPDATE tasks SET notification_conversation_id=? WHERE id=?", "foreign", task.id);
  try {
    await internals.onTaskEvent({ type: "TASK_RESULT", taskId: task.id, payload: { summary: "should not send" } }, runtime.tasks.getTask(task.id));
    assert.equal(runtime.db.get<{ count: number }>("SELECT count(*) AS count FROM main_turn_queue")?.count, 0);
  } finally { await runtime.stop(); await rm(root, { recursive: true, force: true }); }
});
