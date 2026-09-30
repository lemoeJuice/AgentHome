import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeApp } from "../src/runtime/runtime.js";
import { PiTurnError } from "../src/runtime/pi.js";
import { deriveCapabilities } from "../src/auth.js";
import type { AppConfig } from "../src/config.js";
import type { Logger } from "../src/shared/logger.js";
import type { CapabilitySet, ConversationAddress, PlatformMessageRef } from "../src/shared/types.js";

const logger = { child: () => logger, info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger;

function runtimeTestConfig(config: AppConfig): AppConfig {
  return { ...config, systemAdmins: config.systemAdmins ?? [{ platform: "qq", accountId: "a", userId: "admin" }], principalExecution: { maxWorkersPerPrincipal: 1, taskTimeoutMs: 1_800_000, commandTimeoutMs: 600_000, cpuSeconds: 600, memoryBytes: 16 * 1024 * 1024 * 1024, pids: 128, maxFileBytes: 512 * 1024 * 1024, workspaceQuotaBytes: 2 * 1024 * 1024 * 1024, cacheQuotaBytes: 1024 * 1024 * 1024, artifactQuotaBytes: 512 * 1024 * 1024, ...config.principalExecution } };
}

test("runtime ingress is enqueue-before-ACK and deduplicated", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-home-runtime-"));
  const config = { instanceId: "test", owner: { platform: "qq", accountId: "a", userId: "owner" }, paths: { gatewayState: join(root, "gateway.sqlite"), pluginData: join(root, "plugins"), backupDir: join(root, "backups"), stateRoot: root, runtimeSocket: join(root, "run.sock") }, snowluma: { accountId: "a", endpoint: "ws://127.0.0.1:1", apiEndpoint: "http://127.0.0.1:1", accessTokenEnv: "NO_TOKEN", reverseWebSocketPath: "/ws", reconnectMs: 10, requestTimeoutMs: 10 }, chat: { global: { commandRequireMention: false, naturalLanguageMode: "explicit_wake" }, qq: { commandRequireMention: false, naturalLanguageMode: "explicit_wake" }, conversationOverrides: {} }, runtime: { maxInFlight: 2, maxWorkers: 1, maxArtifactBytes: 100000, piCommand: "missing-pi", piTimeoutMs: 100 }, plugins: { enabled: [] }, logging: { level: "error" } } as AppConfig;
  const runtime = new RuntimeApp(runtimeTestConfig(config), logger);
  const event = { protocolVersion: 1 as const, eventId: "evt-1", instanceId: "test", type: "chat.message" as const, occurredAt: new Date().toISOString(), source: { platform: "qq", accountId: "a", adapter: "test" }, trustedIdentity: { userId: "owner" }, conversation: { conversationId: "external", address: { platform: "qq", accountId: "a", kind: "private" as const, platformConversationId: "owner", threadId: null } }, message: { ref: { platform: "qq", accountId: "a", platformConversationId: "owner", threadId: null, messageId: "m" }, replyTo: null }, payload: { text: "hello" } };
  const first = await runtime.receive(event);
  const second = await runtime.receive(event);
  assert.equal(first.status, "accepted");
  assert.equal(second.status, "duplicate");
  assert.ok(["PENDING", "PROCESSING", "DONE", "FAILED"].includes(runtime.db.get<{ status: string }>("SELECT status FROM ingress_events WHERE event_id='evt-1'")?.status ?? ""));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.match(runtime.db.get<{ principal_id: string }>("SELECT principal_id FROM platform_identities WHERE user_id='owner'")?.principal_id ?? "", /^principal_[A-Za-z0-9_-]+$/);
  await runtime.stop();
  await rm(root, { recursive: true, force: true });
});

test("Principal binding unifies identities without assigning Conversation roles", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-home-principal-binding-"));
  const config = { instanceId: "principal-binding", owner: { platform: "qq", accountId: "a", userId: "owner" }, paths: { gatewayState: join(root, "gateway.sqlite"), pluginData: join(root, "plugins"), backupDir: join(root, "backups"), stateRoot: root, runtimeSocket: join(root, "run.sock") }, snowluma: { accountId: "a", endpoint: "ws://127.0.0.1:1", apiEndpoint: "http://127.0.0.1:1", accessTokenEnv: "NO_TOKEN", reverseWebSocketPath: "/ws", reconnectMs: 10, requestTimeoutMs: 10 }, chat: { global: { commandRequireMention: false, naturalLanguageMode: "explicit_wake" }, qq: { commandRequireMention: false, naturalLanguageMode: "explicit_wake" }, conversationOverrides: {} }, runtime: { maxInFlight: 2, maxWorkers: 1, maxArtifactBytes: 100000, piCommand: "missing-pi", piTimeoutMs: 100 }, plugins: { enabled: [] }, logging: { level: "error" } } as AppConfig;
  const runtime = new RuntimeApp(runtimeTestConfig(config), logger);
  const internals = runtime as unknown as {
    resolvePrincipalIdentity: (platform: string, accountId: string, userId: string) => { principalId: string };
    bindPlatformIdentity: (actor: { platform: string; accountId: string; userId: string }, target: { platform: string; accountId: string; userId: string }) => void;
    unbindPlatformIdentity: (actor: { platform: string; accountId: string; userId: string }, target: { platform: string; accountId: string; userId: string }) => void;
    getOrCreateConversation: (value: ConversationAddress) => { id: string; address: ConversationAddress };
  };
  try {
    const guest = internals.resolvePrincipalIdentity("telegram", "bot-b", "user-1");
    assert.match(guest.principalId, /^principal_/);
    assert.throws(() => internals.bindPlatformIdentity({ platform: "telegram", accountId: "bot-b", userId: "user-1" }, { platform: "telegram", accountId: "bot-b", userId: "user-2" }), /SYSTEM_ADMIN_REQUIRED/);

    internals.bindPlatformIdentity({ platform: "qq", accountId: "a", userId: "admin" }, { platform: "telegram", accountId: "bot-b", userId: "user-1" });
    const bound = internals.resolvePrincipalIdentity("telegram", "bot-b", "user-1");
    assert.deepEqual(bound, { principalId: internals.resolvePrincipalIdentity("qq", "a", "admin").principalId });
    internals.unbindPlatformIdentity({ platform: "qq", accountId: "a", userId: "admin" }, { platform: "telegram", accountId: "bot-b", userId: "user-1" });
    const unbound = internals.resolvePrincipalIdentity("telegram", "bot-b", "user-1");
    assert.notEqual(unbound.principalId, bound.principalId);

    const groupAddress: ConversationAddress = { platform: "qq", accountId: "a", kind: "group", platformConversationId: "group-1", threadId: null };
    const group = internals.getOrCreateConversation(groupAddress);
    const groupCaps = deriveCapabilities({ platform: "qq", accountId: "a", userId: "admin", principalId: bound.principalId, conversationId: group.id }, groupAddress, group.id);
    assert.equal(groupCaps.tasks.canCreate, true);
    assert.deepEqual(groupCaps.projects, [{ projectId: "*", access: "WRITE" }]);
    assert.deepEqual(groupCaps.memory.allowedScopes, [`user:${bound.principalId}`, `workspace:${group.id}`]);
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
  const runtime = new RuntimeApp(runtimeTestConfig(config), logger);
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
  const runtime = new RuntimeApp(runtimeTestConfig(config), logger);
  const prompts: string[] = [];
  const sentTexts: string[] = [];
  let retryablePromptAttempts = 0;
  let activeTurns = 0;
  let maxActiveTurns = 0;
  const internals = runtime as unknown as { pi: { createSession: (path: string) => Promise<{ sessionId: string; sessionPath: string }>; send: (session: { sessionId: string; sessionPath: string }, prompt: string) => Promise<string>; stop: () => Promise<void> }; qq: { sendMessage: (target: unknown, message: { text: string }) => Promise<unknown> }; mainToolContexts: Map<string, { conversationId: string; requesterId: string; requester: { platform: string; accountId: string; userId: string; principalId?: string }; capabilities: CapabilitySet }>; processMainTurnJob: (job: { kind: "TASK_EVENT"; taskId: string; eventType: string; payload: Record<string, unknown> }) => Promise<void> };
  internals.pi = { createSession: async (path) => ({ sessionId: `main-session-${path}`, sessionPath: path }), send: async (_session, prompt) => { prompts.push(prompt); activeTurns += 1; maxActiveTurns = Math.max(maxActiveTurns, activeTurns); await new Promise((resolve) => setTimeout(resolve, 10)); activeTurns -= 1; if (prompt.includes("retryable message") && retryablePromptAttempts++ === 0) throw new Error("fetch failed"); if (prompt.includes("tool already called")) throw new PiTurnError("fetch failed", true); return `response-${prompts.length}`; }, stop: async () => {} };
  internals.qq = { sendMessage: async (_target, message) => { sentTexts.push(message.text); return { message: { platform: "qq", accountId: "a", platformConversationId: "owner", threadId: null, messageId: `out-${prompts.length}` }, accepted: true, echoedText: message.text }; } };
  const event = (eventId: string, text: string, group = false) => ({ protocolVersion: 1 as const, eventId, instanceId: "main-queue", type: "chat.message" as const, occurredAt: new Date().toISOString(), source: { platform: "qq", accountId: "a", adapter: "test" }, trustedIdentity: { userId: group ? "guest" : "owner" }, conversation: { conversationId: "external", address: { platform: "qq", accountId: "a", kind: group ? "group" as const : "private" as const, platformConversationId: group ? "group-1" : "owner", threadId: null } }, message: { ref: { platform: "qq", accountId: "a", platformConversationId: group ? "group-1" : "owner", threadId: null, messageId: eventId }, replyTo: null }, payload: { text } });
  try {
    await runtime.start();
    await runtime.receive(event("main-1", "first message"));
    await runtime.receive(event("main-2", "second message"));
    await runtime.receive(event("main-3", "group message", true));
    for (let index = 0; index < 100 && runtime.db.get<{ count: number }>("SELECT count(*) AS count FROM main_turn_queue WHERE status='DONE'")?.count !== 3; index += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(prompts.filter((prompt) => prompt.includes("first message")).length, 1);
    assert.equal(prompts.filter((prompt) => prompt.includes("second message")).length, 1);
    assert.ok(prompts.findIndex((prompt) => prompt.includes("first message")) < prompts.findIndex((prompt) => prompt.includes("second message")));
    assert.match(prompts[0] ?? "", /The trigger summary is the user-message content for this turn/);
    assert.doesNotMatch(prompts[0] ?? "", /Always call get_current_message/);
    assert.match(prompts[0] ?? "", /currentMessageId/);
    assert.ok(maxActiveTurns >= 2);
    assert.equal(runtime.db.get<{ count: number }>("SELECT count(*) AS count FROM main_turn_queue WHERE status='DONE'")?.count, 3);
    const ownerContext = [...internals.mainToolContexts.values()].find((context) => context.requesterId === "owner");
    assert.match(ownerContext?.requester.principalId ?? "", /^principal_/);
    assert.ok(ownerContext);
    const task = runtime.tasks.createTask({ title: "visible task", goal: "visible task", requester: ownerContext.requester, originConversationId: ownerContext.conversationId, notificationConversationId: ownerContext.conversationId, parentCapabilities: ownerContext.capabilities });
    assert.ok(runtime.tasks.listTasks(ownerContext.conversationId, ownerContext.capabilities, ownerContext.requester.principalId).some((item) => item.id === task.id));
    await internals.processMainTurnJob({ kind: "TASK_EVENT", taskId: task.id, eventType: "TASK_RESULT", payload: { outcome: "COMPLETED", summary: "verified worker result" } });
    assert.match(prompts.at(-1) ?? "", /调用 finish_task/);
    assert.match(prompts.at(-1) ?? "", new RegExp(task.id.slice(-8)));
    await runtime.receive(event("main-retry", "retryable message"));
    for (let index = 0; index < 500 && runtime.db.get<{ status: string }>("SELECT status FROM main_turn_queue WHERE job_json LIKE '%retryable message%' ORDER BY created_at DESC LIMIT 1")?.status !== "DONE"; index += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    const retried = runtime.db.get<{ status: string; attempts: number }>("SELECT status,attempts FROM main_turn_queue WHERE job_json LIKE '%retryable message%' ORDER BY created_at DESC LIMIT 1");
    assert.equal(retried?.status, "DONE");
    assert.equal(retried?.attempts, 2);
    assert.equal(sentTexts.filter((text) => text.includes("已保留，Runtime 会自动重试")).length, 1);
    assert.ok(sentTexts.some((text) => text.startsWith("response-")));
    await runtime.receive(event("main-after-tool", "tool already called"));
    for (let index = 0; index < 100 && runtime.db.get<{ status: string }>("SELECT status FROM main_turn_queue WHERE job_json LIKE '%tool already called%' ORDER BY created_at DESC LIMIT 1")?.status !== "DONE"; index += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    const noReplay = runtime.db.get<{ status: string; attempts: number }>("SELECT status,attempts FROM main_turn_queue WHERE job_json LIKE '%tool already called%' ORDER BY created_at DESC LIMIT 1");
    assert.equal(noReplay?.status, "DONE");
    assert.equal(noReplay?.attempts, 1);
    assert.ok(sentTexts.some((text) => text.includes("为避免重复执行")));
  } finally {
    await runtime.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime outbound intents recover after failed delivery", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-home-outbound-"));
  const config = { instanceId: "outbound", owner: { platform: "qq", accountId: "a", userId: "owner" }, paths: { gatewayState: join(root, "gateway.sqlite"), pluginData: join(root, "plugins"), backupDir: join(root, "backups"), stateRoot: root, runtimeSocket: join(root, "run.sock") }, snowluma: { accountId: "a", endpoint: "ws://127.0.0.1:1", apiEndpoint: "http://127.0.0.1:1", accessTokenEnv: "NO_TOKEN", reverseWebSocketPath: "/ws", reconnectMs: 10, requestTimeoutMs: 10 }, chat: { global: { commandRequireMention: false, naturalLanguageMode: "explicit_wake" }, qq: { commandRequireMention: false, naturalLanguageMode: "explicit_wake" }, conversationOverrides: {} }, runtime: { maxInFlight: 2, maxWorkers: 1, maxArtifactBytes: 100000, piCommand: "missing-pi", piTimeoutMs: 100 }, plugins: { enabled: [] }, logging: { level: "error" } } as AppConfig;
  const event = { protocolVersion: 1 as const, eventId: "outbound-1", instanceId: "outbound", type: "chat.message" as const, occurredAt: new Date().toISOString(), source: { platform: "qq", accountId: "a", adapter: "test" }, trustedIdentity: { userId: "owner" }, conversation: { conversationId: "external", address: { platform: "qq", accountId: "a", kind: "private" as const, platformConversationId: "owner", threadId: null } }, message: { ref: { platform: "qq", accountId: "a", platformConversationId: "owner", threadId: null, messageId: "outbound-1" }, replyTo: null }, payload: { text: "first message" } };
  const installFakes = (runtime: RuntimeApp, fail: boolean) => {
    const internals = runtime as unknown as { pi: { createSession: (path: string) => Promise<{ sessionId: string; sessionPath: string }>; send: () => Promise<string>; stop: () => Promise<void> }; qq: { sendMessage: () => Promise<unknown> } };
    internals.pi = { createSession: async (path) => ({ sessionId: "main-session", sessionPath: path }), send: async () => "response", stop: async () => {} };
    internals.qq = { sendMessage: async () => { if (fail) throw new Error("DELIVERY_FAILED"); return { message: { platform: "qq", accountId: "a", platformConversationId: "owner", threadId: null, messageId: "outbound-reply" }, accepted: true }; } };
  };
  const first = new RuntimeApp(runtimeTestConfig(config), logger); installFakes(first, true);
  try {
    await first.start(); await first.receive(event);
    for (let index = 0; index < 100 && (first.db.get<{ count: number }>("SELECT count(*) AS count FROM runtime_outbound_intents WHERE status='PENDING'")?.count ?? 0) < 2; index += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(first.db.get<{ count: number }>("SELECT count(*) AS count FROM runtime_outbound_intents WHERE status='PENDING'")?.count, 2, JSON.stringify({ intents: first.db.all("SELECT id,status,last_error FROM runtime_outbound_intents"), queue: first.db.all("SELECT id,status,error FROM main_turn_queue") }));
    first.db.run("UPDATE runtime_outbound_intents SET status='DELIVERING',lease_until=?", "2020-01-01T00:00:00.000Z");
  } finally { await first.stop(); }
  const second = new RuntimeApp(runtimeTestConfig(config), logger); installFakes(second, false);
  try {
    await second.start();
    assert.equal(second.db.get<{ count: number }>("SELECT count(*) AS count FROM runtime_outbound_intents WHERE status='ACKED'")?.count, 2, JSON.stringify(second.db.all("SELECT id,status,attempts,last_error,lease_until FROM runtime_outbound_intents")));
  } finally { await second.stop(); await rm(root, { recursive: true, force: true }); }
});

test("Main uses native SnowLuma actions and on-demand stream downloads become Artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-home-main-qq-tools-"));
  const config = { instanceId: "main-qq-tools", owner: { platform: "qq", accountId: "a", userId: "owner" }, paths: { gatewayState: join(root, "gateway.sqlite"), pluginData: join(root, "plugins"), backupDir: join(root, "backups"), stateRoot: root, runtimeSocket: join(root, "run.sock") }, snowluma: { accountId: "a", endpoint: "ws://127.0.0.1:1", apiEndpoint: "http://127.0.0.1:1", accessTokenEnv: "NO_TOKEN", reverseWebSocketPath: "/ws", reconnectMs: 10, requestTimeoutMs: 10 }, chat: { global: { commandRequireMention: false, naturalLanguageMode: "explicit_wake" }, qq: { commandRequireMention: false, naturalLanguageMode: "explicit_wake" }, conversationOverrides: {} }, runtime: { maxInFlight: 2, maxWorkers: 1, maxArtifactBytes: 100000, piCommand: "missing-pi", piTimeoutMs: 100 }, plugins: { enabled: [] }, logging: { level: "error" } } as AppConfig;
  const runtime = new RuntimeApp(runtimeTestConfig(config), logger);
  const address: ConversationAddress = { platform: "qq", accountId: "a", kind: "group", platformConversationId: "group-1", threadId: null };
  const otherAddress: ConversationAddress = { ...address, platformConversationId: "group-2" };
  const ref: PlatformMessageRef = { platform: "qq", accountId: "a", platformConversationId: "group-1", threadId: null, messageId: "42" };
  const internals = runtime as unknown as {
    getOrCreateConversation: (value: ConversationAddress) => { id: string; address: ConversationAddress };
    handleMainTool: (action: string, input: unknown, context: unknown) => Promise<unknown>;
    qq: { readNativeStreamDownload: (value: unknown) => Promise<{ filename: string; mime?: string; size?: number; stream: AsyncIterable<Uint8Array> }> };
    snowlumaMcp: {
      listActions: (category?: string) => Promise<unknown>;
      searchActions: (query: string) => Promise<unknown>;
      getAction: (name: string) => Promise<unknown>;
      queryAction: (action: string, params?: Record<string, unknown>) => Promise<unknown>;
      invokeAction: (action: string, params?: Record<string, unknown>) => Promise<unknown>;
      stop: () => Promise<void>;
    };
  };
  const conversation = internals.getOrCreateConversation(address);
  internals.getOrCreateConversation(otherAddress);
  const imageBytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  internals.qq = {
    readNativeStreamDownload: async () => ({ filename: "image.jpg", size: imageBytes.byteLength, stream: (async function* () { yield imageBytes; })() }),
  };
  const snowlumaCalls: Array<{ tool: string; action?: string; params?: Record<string, unknown> }> = [];
  internals.snowlumaMcp = {
    listActions: async (category) => { snowlumaCalls.push({ tool: "list_actions", params: { category } }); return [{ name: "send_private_msg", category: "消息" }]; },
    searchActions: async (query) => { snowlumaCalls.push({ tool: "search_actions", params: { query } }); return [{ name: "send_private_msg" }]; },
    getAction: async (name) => { snowlumaCalls.push({ tool: "get_action", action: name }); return { name, inputSchema: { type: "object" } }; },
    queryAction: async (action, params) => { snowlumaCalls.push({ tool: "query_action", action, params }); return { action, params }; },
    invokeAction: async (action, params) => { snowlumaCalls.push({ tool: "invoke_action", action, params }); return action.startsWith("download_file_") ? { file_path: "/state/snowluma/mcp/streams/image.jpg", file_size: imageBytes.byteLength } : { action, accepted: true }; },
    stop: async () => {},
  };
  const capabilities = {
    memory: { allowedScopes: ["user:admin"] }, projects: [], qq: { readConversations: [conversation.id], sendConversations: [conversation.id] }, plugins: { allowedActions: [] }, artifacts: { readableArtifactAuthorities: ["agent-home"], publishTaskIds: [], allowedDestinations: [conversation.id] }, tasks: { canCreate: true, visibleTaskIds: [], canCancel: true, canFollowUp: true },
  } as CapabilitySet;
   const context = { conversationId: conversation.id, requesterId: "admin", requester: { platform: "qq", accountId: "a", userId: "admin", principalId: "principal:admin" }, address, capabilities, eventId: "artifact-event", message: ref, replyTo: { ...ref, messageId: "7" } };
  try {
    const artifact = await runtime.artifacts.ingestAttachment({ stream: (async function* () { yield Buffer.from("authorized artifact"); })(), filename: "note.txt", mime: "text/plain", conversationId: conversation.id, requesterId: "admin", eventId: "artifact-event", maxBytes: 1000 });
    const fetched = await internals.handleMainTool("invoke_snowluma_action", { action: "download_file_image_stream", params: { file_id: "image-history" } }, context) as { filename: string; mime: string; ref: { artifactId: string }; imageInput: { type: string; data: string; mimeType: string } };
    assert.equal(fetched.filename, "image.jpg");
    assert.equal(fetched.mime, "image/jpeg");
    assert.equal(fetched.imageInput.type, "image");
    assert.equal(fetched.imageInput.mimeType, "image/jpeg");
    assert.equal(fetched.imageInput.data, imageBytes.toString("base64"));
    assert.ok(runtime.artifacts.get({ authority: "agent-home", artifactId: fetched.ref.artifactId }));
    assert.equal((await internals.handleMainTool("read_artifact", { ref: artifact.ref }, context) as { content: string }).content, "authorized artifact");
    assert.deepEqual(await internals.handleMainTool("list_snowluma_actions", { category: "消息" }, context), [{ name: "send_private_msg", category: "消息" }]);
    assert.deepEqual(await internals.handleMainTool("search_snowluma_actions", { query: "私聊" }, context), [{ name: "send_private_msg" }]);
    assert.deepEqual(await internals.handleMainTool("get_snowluma_action", { name: "send_private_msg" }, context), { name: "send_private_msg", inputSchema: { type: "object" } });
    assert.deepEqual(await internals.handleMainTool("query_snowluma_action", { action: "get_friend_list", params: {} }, context), { action: "get_friend_list", params: {} });
    assert.deepEqual(await internals.handleMainTool("invoke_snowluma_action", { action: "send_private_msg", params: { user_id: 1234, message: [{ type: "text", data: { text: "hi" } }] } }, context), { action: "send_private_msg", accepted: true });
    await assert.rejects(() => internals.handleMainTool("invoke_snowluma_action", { action: "send_private_msg", params: { user_id: 1234 } }, { ...context, taskId: "task-worker", workerId: "worker-child" }), /SYSTEM_ADMIN_REQUIRED/);
    const ordinaryCaps = deriveCapabilities({ platform: "qq", accountId: "a", userId: "ordinary", principalId: "principal:ordinary", conversationId: conversation.id }, address, conversation.id);
    await assert.rejects(() => internals.handleMainTool("invoke_snowluma_action", { action: "send_private_msg", params: { user_id: 1234 } }, { ...context, requesterId: "ordinary", requester: { platform: "qq", accountId: "a", userId: "ordinary", principalId: "principal:ordinary" }, capabilities: ordinaryCaps }), /SYSTEM_ADMIN_REQUIRED/);
    assert.equal(snowlumaCalls.filter((call) => call.tool === "invoke_action").length, 2);
    assert.equal(runtime.db.get<{ count: number }>("SELECT count(*) AS count FROM authorization_audit_events WHERE operation='snowluma.invoke_action' AND decision='DENY'")?.count, 2);
    await assert.rejects(() => internals.handleMainTool("get_current_message", {}, context), /TOOL_NOT_FOUND/);
    await assert.rejects(() => internals.handleMainTool("read_artifact", { ref: artifact.ref }, { ...context, conversationId: "other-conversation" }), /ARTIFACT_CONVERSATION_READ_DENIED/);
    assert.ok(snowlumaCalls.some((call) => call.tool === "invoke_action" && call.action === "download_file_image_stream"));
  } finally {
    await runtime.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime backup quiesce blocks intake until finish", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-home-backup-quiesce-"));
  const config = { instanceId: "backup-quiesce", owner: { platform: "qq", accountId: "a", userId: "owner" }, paths: { gatewayState: join(root, "gateway.sqlite"), pluginData: join(root, "plugins"), backupDir: join(root, "backups"), stateRoot: root, runtimeSocket: join(root, "run.sock") }, snowluma: { accountId: "a", endpoint: "ws://127.0.0.1:1", apiEndpoint: "http://127.0.0.1:1", accessTokenEnv: "NO_TOKEN", reverseWebSocketPath: "/ws", reconnectMs: 10, requestTimeoutMs: 10 }, chat: { global: { commandRequireMention: false, naturalLanguageMode: "explicit_wake" }, qq: { commandRequireMention: false, naturalLanguageMode: "explicit_wake" }, conversationOverrides: {} }, runtime: { maxInFlight: 2, maxWorkers: 1, maxArtifactBytes: 100000, piCommand: "missing-pi", piTimeoutMs: 100 }, plugins: { enabled: [] }, logging: { level: "error" } } as AppConfig;
  const event = { protocolVersion: 1 as const, eventId: "backup-event", instanceId: "backup-quiesce", type: "chat.message" as const, occurredAt: new Date().toISOString(), source: { platform: "qq", accountId: "a", adapter: "test" }, trustedIdentity: { userId: "owner" }, conversation: { conversationId: "external", address: { platform: "qq", accountId: "a", kind: "private" as const, platformConversationId: "owner", threadId: null } }, message: { ref: { platform: "qq", accountId: "a", platformConversationId: "owner", threadId: null, messageId: "backup-message" }, replyTo: null }, payload: { text: "backup" } };
  const first = new RuntimeApp(runtimeTestConfig(config), logger);
  try {
    await first.start();
    assert.deepEqual(await first.backupPrepare(), { status: "quiesced" });
    assert.equal((await first.receive(event)).errorCode, "RUNTIME_QUIESCED");
    assert.deepEqual(await first.backupFinish(), { status: "running" });
    assert.equal((await first.receive(event)).status, "accepted");
  } finally { await first.stop(); }
  const second = new RuntimeApp(runtimeTestConfig(config), logger);
  try {
    await second.start();
    assert.equal((await second.receive({ ...event, eventId: "backup-event-2" })).status, "accepted");
  } finally { await second.stop(); await rm(root, { recursive: true, force: true }); }
});

test("task replay refuses a notification destination outside its persisted capability", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-home-task-notification-"));
  const config = { instanceId: "task-notification", owner: { platform: "qq", accountId: "a", userId: "owner" }, paths: { gatewayState: join(root, "gateway.sqlite"), pluginData: join(root, "plugins"), backupDir: join(root, "backups"), stateRoot: root, runtimeSocket: join(root, "run.sock") }, snowluma: { accountId: "a", endpoint: "ws://127.0.0.1:1", apiEndpoint: "http://127.0.0.1:1", accessTokenEnv: "NO_TOKEN", reverseWebSocketPath: "/ws", reconnectMs: 10, requestTimeoutMs: 10 }, chat: { global: { commandRequireMention: false, naturalLanguageMode: "explicit_wake" }, qq: { commandRequireMention: false, naturalLanguageMode: "explicit_wake" }, conversationOverrides: {} }, runtime: { maxInFlight: 2, maxWorkers: 1, maxArtifactBytes: 100000, piCommand: "missing-pi", piTimeoutMs: 100 }, plugins: { enabled: [] }, logging: { level: "error" } } as AppConfig;
  const runtime = new RuntimeApp(runtimeTestConfig(config), logger);
  const internals = runtime as unknown as { onTaskEvent: (event: unknown, task: unknown) => Promise<void> };
  const caps = { memory: { allowedScopes: ["workspace:allowed"] }, projects: [], qq: { readConversations: ["allowed"], sendConversations: ["allowed"] }, plugins: { allowedActions: [] }, artifacts: { readableArtifactAuthorities: ["agent-home"], publishTaskIds: [], allowedDestinations: ["allowed"] }, tasks: { canCreate: true, visibleTaskIds: [], canCancel: true, canFollowUp: true } };
  const task = runtime.tasks.createTask({ title: "notification", goal: "notification", requester: { platform: "qq", accountId: "a", userId: "owner" }, originConversationId: "allowed", notificationConversationId: "allowed", parentCapabilities: caps });
  runtime.db.run("UPDATE tasks SET notification_conversation_id=? WHERE id=?", "foreign", task.id);
  try {
    await internals.onTaskEvent({ type: "TASK_RESULT", taskId: task.id, payload: { summary: "should not send" } }, runtime.tasks.getTask(task.id));
    assert.equal(runtime.db.get<{ count: number }>("SELECT count(*) AS count FROM main_turn_queue")?.count, 0);
  } finally { await runtime.stop(); await rm(root, { recursive: true, force: true }); }
});
