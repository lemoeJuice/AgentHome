import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { OneBotClient, resolveWebSocketEndpoint } from "../src/qq/onebot.js";
import { normalizeQQEvent, parseSegments, QQChatPlatformAdapter } from "../src/qq/adapter.js";
import { SnowLumaQQCapability } from "../src/qq/capability.js";
import type { SnowLumaMcpActions } from "../src/runtime/snowluma-mcp.js";
import { SqliteStore, migrate } from "../src/db.js";
import { runtimeMigrations } from "../src/schema.js";
import { ArtifactService } from "../src/runtime/artifacts.js";
import type { AppConfig } from "../src/config.js";
import type { Logger } from "../src/shared/logger.js";

const logger = { child: () => logger, info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger;

function fakeMcp(overrides: Partial<SnowLumaMcpActions> = {}): SnowLumaMcpActions {
  return {
    listActions: async () => [],
    searchActions: async () => [],
    getAction: async () => ({}),
    queryAction: async <T>() => ({}) as T,
    invokeAction: async <T>() => ({}) as T,
    stop: async () => {},
    ...overrides,
  };
}

test("SnowLuma WebSocket path is appended exactly once", () => {
  assert.equal(resolveWebSocketEndpoint("ws://127.0.0.1:3001", "/onebot/v11/ws"), "ws://127.0.0.1:3001/onebot/v11/ws");
  assert.equal(resolveWebSocketEndpoint("ws://127.0.0.1:3001/onebot/v11/ws", "/onebot/v11/ws"), "ws://127.0.0.1:3001/onebot/v11/ws");
});

test("QQ segment normalization matches the actual bot mention", () => {
  const parsed = parseSegments([
    { type: "at", data: { qq: "42" } },
    { type: "reply", data: { id: 7 } },
    { type: "image", data: { file: "image-id" } },
    { type: "file", data: { file: "file-id", name: "report.txt" } },
  ], "42");
  assert.equal(parsed.mentionsBot, true);
  assert.equal(parsed.replyTo?.messageId, "7");
  assert.deepEqual(parsed.attachments.map((item) => item.id), ["image-id", "file-id"]);
  assert.equal(parseSegments([{ type: "at", data: { qq: "99" } }], "42").mentionsBot, false);
  assert.equal(parseSegments([{ type: "at", data: { qq: "all" } }], "42").mentionsBot, true);
});

async function withHttpServer(handler: (path: string, body: Record<string, unknown>, token: string | undefined) => unknown, run: (endpoint: string) => Promise<void>): Promise<void> {
  const server = createServer(async (request, response) => {
    let input = "";
    for await (const chunk of request) input += String(chunk);
    const body = input ? JSON.parse(input) as Record<string, unknown> : {};
    const result = handler(request.url ?? "", body, request.headers.authorization);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(result));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try { await run(`http://127.0.0.1:${address.port}`); } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
}

test("OneBot actions use SnowLuma action paths and validate envelopes", async () => {
  await withHttpServer((path, body, token) => {
    assert.equal(path, "/get_group_msg_history");
    assert.equal(token, undefined);
    assert.deepEqual(body, { group_id: 42, count: 2, message_id: 7 });
    return { status: "ok", retcode: 0, data: { messages: [] } };
  }, async (endpoint) => {
    const client = new OneBotClient({ websocketEndpoint: "ws://127.0.0.1:1", apiEndpoint: endpoint, reconnectMs: 10, requestTimeoutMs: 1000 }, logger);
    assert.deepEqual(await client.action("get_group_msg_history", { group_id: 42, count: 2, message_id: 7 }), { messages: [] });
  });

  await withHttpServer(() => ({ status: "failed", retcode: 1200, data: null, wording: "message not found" }), async (endpoint) => {
    const client = new OneBotClient({ websocketEndpoint: "ws://127.0.0.1:1", apiEndpoint: endpoint, reconnectMs: 10, requestTimeoutMs: 1000 }, logger);
    await assert.rejects(() => client.action("get_msg", { message_id: 7 }), /ONEBOT_ACTION_FAILED:get_msg:message not found/);
  });
});

test("lazy message reads reject a provider response from another conversation", async () => {
  await withHttpServer((path) => {
    assert.equal(path, "/get_msg");
    return { status: "ok", retcode: 0, data: { message_id: 9, message_type: "group", group_id: 99, user_id: 8, time: 1, message: [{ type: "text", data: { text: "foreign" } }] } };
  }, async (endpoint) => {
    const config = {
      instanceId: "test", owner: { platform: "qq", accountId: "default", userId: "8" },
      paths: { gatewayState: "./gateway.sqlite", pluginData: "./plugins", backupDir: "./backups", stateRoot: "/tmp", runtimeSocket: "/run/agent-home/control.sock" },
      snowluma: { accountId: "default", endpoint: "ws://127.0.0.1:1", apiEndpoint: endpoint, reverseWebSocketPath: "/", reconnectMs: 10, requestTimeoutMs: 1000 },
      chat: { global: { commandRequireMention: false, naturalLanguageMode: "explicit_wake" as const }, qq: { commandRequireMention: false, naturalLanguageMode: "explicit_wake" as const }, conversationOverrides: {} },
      runtime: { maxInFlight: 2, maxWorkers: 1, maxArtifactBytes: 1000, piCommand: "pi", piTimeoutMs: 1000 }, plugins: { enabled: [] }, logging: { level: "error" as const },
    } as AppConfig;
    const ref = { platform: "qq", accountId: "default", platformConversationId: "42", threadId: null, messageId: "9" } as const;
    const db = new SqliteStore(":memory:");
    migrate(db, runtimeMigrations);
    try {
      const mcp = fakeMcp({ queryAction: async <T>() => ({ message_id: 9, message_type: "group", group_id: 99, user_id: 8, time: 1, message: [{ type: "text", data: { text: "foreign" } }] }) as T });
      const capabilities = { memory: { allowedScopes: [] }, projects: [], qq: { readConversations: ["conversation-1"], sendConversations: [] }, plugins: { allowedActions: [] }, artifacts: { readableArtifactAuthorities: [], publishTaskIds: [], allowedDestinations: [] }, tasks: { canCreate: false, visibleTaskIds: [], canCancel: false, canFollowUp: false } };
      await assert.rejects(() => new SnowLumaQQCapability(config, new ArtifactService(db, "/tmp"), logger, mcp).getMessage(ref, "group", { conversationId: "conversation-1", capabilities, target: { platform: "qq", accountId: "default", kind: "group", platformConversationId: "42", threadId: null } }), /QQ_MESSAGE_SCOPE_MISMATCH/);
    } finally { db.close(); }
  });
});

test("QQ history consumes SnowLuma data.messages and numeric IDs", async () => {
  const config = {
    instanceId: "test",
    owner: { platform: "qq", accountId: "default", userId: "8" },
    paths: { gatewayState: "./gateway.sqlite", pluginData: "./plugins", backupDir: "./backups", stateRoot: "/state", runtimeSocket: "/run/agent-home/control.sock" },
    snowluma: { accountId: "default", endpoint: "ws://127.0.0.1:1", apiEndpoint: "http://127.0.0.1:1", reverseWebSocketPath: "/", reconnectMs: 10, requestTimeoutMs: 1000 },
    chat: { global: { commandRequireMention: false, naturalLanguageMode: "explicit_wake" as const }, qq: { commandRequireMention: false, naturalLanguageMode: "explicit_wake" as const }, conversationOverrides: {} },
    runtime: { maxInFlight: 2, maxWorkers: 1, maxArtifactBytes: 1000, piCommand: "pi", piTimeoutMs: 1000 },
    plugins: { enabled: [] },
    logging: { level: "error" as const },
  } as AppConfig;
  const db = new SqliteStore(":memory:");
  try {
    migrate(db, runtimeMigrations);
    const conversation = { platform: "qq", accountId: "default", kind: "group" as const, platformConversationId: "42", threadId: null };
    const capabilities = { memory: { allowedScopes: [] }, projects: [], qq: { readConversations: ["conversation-1"], sendConversations: [] }, plugins: { allowedActions: [] }, artifacts: { readableArtifactAuthorities: [], publishTaskIds: [], allowedDestinations: [] }, tasks: { canCreate: false, visibleTaskIds: [], canCancel: false, canFollowUp: false } };
    const mcp = fakeMcp({ queryAction: async <T>(action, params) => {
      assert.equal(action, "get_group_msg_history");
      assert.deepEqual(params, { group_id: 42, count: 1 });
      return { messages: [{ message_id: 9, message_type: "group", group_id: 42, user_id: 8, time: 1, message: [{ type: "text", data: { text: "hello" } }] }] } as T;
    } });
    const events = await new SnowLumaQQCapability(config, new ArtifactService(db, "/tmp"), logger, mcp).getHistory({ conversation, limit: 1 }, { conversationId: "conversation-1", capabilities, target: conversation });
    assert.equal(Array.isArray(events) ? events.length : 0, 1);
    assert.equal(Array.isArray(events) ? events[0]?.message.text : undefined, "hello");
    assert.equal(Array.isArray(events) ? events[0]?.message.ref.messageId : undefined, "9");
  } finally { db.close(); }
});

test("QQ capability normalizes lazy message responses", () => {
  const config = {
    instanceId: "test", owner: { platform: "qq", accountId: "default", userId: "8" },
    paths: { gatewayState: "./gateway.sqlite", pluginData: "./plugins", backupDir: "./backups", stateRoot: "/state", runtimeSocket: "/run/agent-home/control.sock" },
    snowluma: { accountId: "default", endpoint: "ws://127.0.0.1:1", apiEndpoint: "http://127.0.0.1:1", reverseWebSocketPath: "/", reconnectMs: 10, requestTimeoutMs: 1000 },
    chat: { global: { commandRequireMention: false, naturalLanguageMode: "explicit_wake" as const }, qq: { commandRequireMention: false, naturalLanguageMode: "explicit_wake" as const }, conversationOverrides: {} },
    runtime: { maxInFlight: 2, maxWorkers: 1, maxArtifactBytes: 1000, piCommand: "pi", piTimeoutMs: 1000 }, plugins: { enabled: [] }, logging: { level: "error" as const },
  } as AppConfig;
  const event = normalizeQQEvent({ message_type: "private", user_id: 8, message_id: 9, time: 1, message: [{ type: "text", data: { text: "lazy" } }] }, config);
  assert.equal(event?.message.text, "lazy");
  assert.equal(event?.message.ref.messageId, "9");
  assert.equal(event?.conversation.kind, "private");
});

test("QQ capability accepts negative OneBot message IDs", async () => {
  const config = {
    instanceId: "test", owner: { platform: "qq", accountId: "default", userId: "8" },
    paths: { gatewayState: "./gateway.sqlite", pluginData: "./plugins", backupDir: "./backups", stateRoot: "/state", runtimeSocket: "/run/agent-home/control.sock" },
    snowluma: { accountId: "default", endpoint: "ws://127.0.0.1:1", apiEndpoint: "http://127.0.0.1:1", reverseWebSocketPath: "/", reconnectMs: 10, requestTimeoutMs: 1000 },
    chat: { global: { commandRequireMention: false, naturalLanguageMode: "explicit_wake" as const }, qq: { commandRequireMention: false, naturalLanguageMode: "explicit_wake" as const }, conversationOverrides: {} },
    runtime: { maxInFlight: 2, maxWorkers: 1, maxArtifactBytes: 1000, piCommand: "pi", piTimeoutMs: 1000 }, plugins: { enabled: [] }, logging: { level: "error" as const },
  } as AppConfig;
  const db = new SqliteStore(":memory:");
  migrate(db, runtimeMigrations);
  try {
    const conversation = { platform: "qq" as const, accountId: "default", kind: "group" as const, platformConversationId: "42", threadId: null };
    const capabilities = { memory: { allowedScopes: [] }, projects: [], qq: { readConversations: ["conversation-1"], sendConversations: [] }, plugins: { allowedActions: [] }, artifacts: { readableArtifactAuthorities: [], publishTaskIds: [], allowedDestinations: [] }, tasks: { canCreate: false, visibleTaskIds: [], canCancel: false, canFollowUp: false } };
    const ref = { ...conversation, messageId: "-1396864604" };
    const mcp = fakeMcp({ queryAction: async <T>(action, params) => {
      assert.equal(action, "get_msg");
      assert.deepEqual(params, { message_id: -1396864604 });
      return { message_id: -1396864604, message_type: "group", group_id: 42, user_id: 8, time: 1, message: [{ type: "image", data: { file: "image-1" } }] } as T;
    } });
    const event = await new SnowLumaQQCapability(config, new ArtifactService(db, "/tmp"), logger, mcp).getMessage(ref, "group", { conversationId: "conversation-1", capabilities, target: conversation });
    assert.equal(event?.message.ref.messageId, "-1396864604");
    assert.equal(event?.message.attachments[0]?.id, "image-1");
  } finally { db.close(); }
});

test("unsupported QQ private history is explicit", async () => {
  const config = {
    instanceId: "test",
    owner: { platform: "qq", accountId: "default", userId: "8" },
    paths: { gatewayState: "./gateway.sqlite", pluginData: "./plugins", backupDir: "./backups", stateRoot: "/state", runtimeSocket: "/run/agent-home/control.sock" },
    snowluma: { accountId: "default", endpoint: "ws://127.0.0.1:1", apiEndpoint: "http://127.0.0.1:1", reverseWebSocketPath: "/", reconnectMs: 10, requestTimeoutMs: 1000 },
    chat: { global: { commandRequireMention: false, naturalLanguageMode: "explicit_wake" as const }, qq: { commandRequireMention: false, naturalLanguageMode: "explicit_wake" as const }, conversationOverrides: {} },
    runtime: { maxInFlight: 2, maxWorkers: 1, maxArtifactBytes: 1000, piCommand: "pi", piTimeoutMs: 1000, workerSandboxCommand: "bwrap" },
    plugins: { enabled: [] },
    logging: { level: "error" as const },
  } as AppConfig;
  const db = new SqliteStore(":memory:");
  try {
    migrate(db, runtimeMigrations);
    const conversation = { platform: "qq", accountId: "default", kind: "private" as const, platformConversationId: "8", threadId: null };
    const capabilities = { memory: { allowedScopes: [] }, projects: [], qq: { readConversations: ["conversation-1"], sendConversations: [] }, plugins: { allowedActions: [] }, artifacts: { readableArtifactAuthorities: [], publishTaskIds: [], allowedDestinations: [] }, tasks: { canCreate: false, visibleTaskIds: [], canCancel: false, canFollowUp: false } };
    assert.deepEqual(await new SnowLumaQQCapability(config, new ArtifactService(db, "/tmp"), logger, fakeMcp()).getHistory({ conversation, limit: 5 }, { conversationId: "conversation-1", capabilities, target: conversation }), { kind: "NOT_IMPLEMENTED" });
  } finally { db.close(); }
});

test("QQ outbound rejects raw URLs instead of treating them as artifacts", async () => {
  const config = {
    instanceId: "test",
    owner: { platform: "qq", accountId: "default", userId: "8" },
    paths: { gatewayState: "./gateway.sqlite", pluginData: "./plugins", backupDir: "./backups", stateRoot: "/state", runtimeSocket: "/run/agent-home/control.sock" },
    snowluma: { accountId: "default", endpoint: "ws://127.0.0.1:1", apiEndpoint: "http://127.0.0.1:1", reverseWebSocketPath: "/", reconnectMs: 10, requestTimeoutMs: 1000 },
    chat: { global: { commandRequireMention: false, naturalLanguageMode: "explicit_wake" as const }, qq: { commandRequireMention: false, naturalLanguageMode: "explicit_wake" as const }, conversationOverrides: {} },
    runtime: { maxInFlight: 2, maxWorkers: 1, maxArtifactBytes: 1000, piCommand: "pi", piTimeoutMs: 1000, workerSandboxCommand: "bwrap" },
    plugins: { enabled: [] },
    logging: { level: "error" as const },
  } as AppConfig;
  const adapter = new QQChatPlatformAdapter(config, logger);
  await assert.rejects(() => adapter.sendMessage({ platform: "qq", accountId: "default", kind: "private", platformConversationId: "8", threadId: null }, { attachments: [{ type: "image", url: "https://attacker.invalid/file" }] } as never), /ARTIFACT_REFERENCE_REQUIRED/);
});

test("Agent QQ capability sends an authorized ArtifactRef", async () => {
  const root = await mkdtemp(join(process.cwd(), ".tmp-qq-artifact-"));
  const project = join(root, "project");
  await mkdir(project);
  await writeFile(join(project, "image.png"), "image-data");
  const db = new SqliteStore(":memory:");
  migrate(db, runtimeMigrations);
  const artifacts = new ArtifactService(db, root);
  const artifactCapability = { readableArtifactAuthorities: ["agent-home"], publishTaskIds: ["task-1"], allowedDestinations: ["conversation-1"] };
  const artifact = await artifacts.registerLocalArtifact({ path: join(project, "image.png"), taskId: "task-1", allowedRoots: [project], capability: artifactCapability, maxBytes: 1000 });
  const config = {
    instanceId: "test",
    owner: { platform: "qq", accountId: "default", userId: "8" },
    paths: { gatewayState: "./gateway.sqlite", pluginData: "./plugins", backupDir: "./backups", stateRoot: root, runtimeSocket: "/run/agent-home/control.sock" },
    snowluma: { accountId: "default", endpoint: "ws://127.0.0.1:1", apiEndpoint: "http://127.0.0.1:1", reverseWebSocketPath: "/", reconnectMs: 10, requestTimeoutMs: 1000 },
    chat: { global: { commandRequireMention: false, naturalLanguageMode: "explicit_wake" as const }, qq: { commandRequireMention: false, naturalLanguageMode: "explicit_wake" as const }, conversationOverrides: {} },
    runtime: { maxInFlight: 2, maxWorkers: 1, maxArtifactBytes: 1000, piCommand: "pi", piTimeoutMs: 1000, workerSandboxCommand: "bwrap" },
    plugins: { enabled: [] },
    logging: { level: "error" as const },
  } as AppConfig;
  try {
    const mcp = fakeMcp({ invokeAction: async <T>(action, params) => {
      assert.equal(action, "send_private_msg");
      assert.equal(params.user_id, 8);
       const message = params.message as Array<{ type: string; data: { file?: string; name?: string } }>;
       assert.equal(message[0]?.type, "image");
       assert.match(message[0]?.data.file ?? "", /^base64:\/\//);
       assert.equal(message[0]?.data.name, "solution.cpp.txt");
      return { message_id: 11 } as T;
    } });
    const capability = new SnowLumaQQCapability(config, artifacts, logger, mcp);
    const sent = await capability.sendMessage(
      { platform: "qq", accountId: "default", kind: "private", platformConversationId: "8", threadId: null },
       { attachments: [{ type: "image", artifact: artifact.ref, filename: "solution.cpp.txt" }] },
      { conversationId: "conversation-1", taskId: "task-1", capabilities: { memory: { allowedScopes: [] }, projects: [], qq: { readConversations: ["conversation-1"], sendConversations: ["conversation-1"] }, plugins: { allowedActions: [] }, artifacts: artifactCapability, tasks: { canCreate: false, visibleTaskIds: [], canCancel: false, canFollowUp: false } } },
    );
    assert.equal(sent.message.messageId, "11");
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("SnowLuma attachment streams require a real regular file below the stream root", async () => {
  const root = await mkdtemp(join(process.cwd(), ".tmp-qq-stream-"));
  const streamRoot = join(root, "snowluma", "mcp", "streams");
  await mkdir(streamRoot, { recursive: true });
  const safePath = join(streamRoot, "safe.bin");
  const outsidePath = join(root, "outside.bin");
  const linkPath = join(streamRoot, "escape.bin");
  await writeFile(safePath, "safe");
  await writeFile(outsidePath, "outside");
  await symlink(outsidePath, linkPath);
  const config = {
    instanceId: "test", owner: { platform: "qq", accountId: "default", userId: "8" },
    paths: { gatewayState: join(root, "gateway.sqlite"), pluginData: root, backupDir: root, stateRoot: root, runtimeSocket: join(root, "runtime.sock") },
    snowluma: { accountId: "default", endpoint: "ws://127.0.0.1:1", apiEndpoint: "http://127.0.0.1:1", reverseWebSocketPath: "/", reconnectMs: 10, requestTimeoutMs: 1000 },
    chat: { global: { commandRequireMention: false, naturalLanguageMode: "explicit_wake" as const }, qq: { commandRequireMention: false, naturalLanguageMode: "explicit_wake" as const }, conversationOverrides: {} },
    runtime: { maxInFlight: 2, maxWorkers: 1, maxArtifactBytes: 1000, piCommand: "pi", piTimeoutMs: 1000, workerSandboxCommand: "bwrap" },
    plugins: { enabled: [] }, logging: { level: "error" as const },
  } as AppConfig;
  const db = new SqliteStore(":memory:"); migrate(db, runtimeMigrations);
  try {
    let requestedPath = safePath;
    const capability = new SnowLumaQQCapability(config, new ArtifactService(db, root), logger, fakeMcp({ invokeAction: async <T>() => ({ file_path: requestedPath } as T) }));
    const authorization = { conversationId: "conversation-1", capabilities: { memory: { allowedScopes: [] }, projects: [], qq: { readConversations: ["conversation-1"], sendConversations: [] }, plugins: { allowedActions: [] }, artifacts: { readableArtifactAuthorities: [], publishTaskIds: [], allowedDestinations: [] }, tasks: { canCreate: false, visibleTaskIds: [], canCancel: false, canFollowUp: false } }, target: { platform: "qq" as const, accountId: "default", kind: "private" as const, platformConversationId: "8", threadId: null } };
    const transfer = await capability.fetchAttachment({ type: "file", id: "safe" }, authorization);
    const chunks: Uint8Array[] = []; for await (const chunk of transfer.stream) chunks.push(chunk);
    assert.equal(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString(), "safe");
    requestedPath = linkPath;
    await assert.rejects(() => capability.fetchAttachment({ type: "file", id: "escape" }, authorization), /ATTACHMENT_PATH_DENIED/);
    requestedPath = streamRoot;
    await assert.rejects(() => capability.fetchAttachment({ type: "file", id: "directory" }, authorization), /ATTACHMENT_PATH_DENIED/);
  } finally {
    db.close(); await rm(root, { recursive: true, force: true });
  }
});
