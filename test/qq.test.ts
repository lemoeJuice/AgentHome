import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { OneBotClient } from "../src/qq/onebot.js";
import { QQChatPlatformAdapter } from "../src/qq/adapter.js";
import type { AppConfig } from "../src/config.js";
import type { Logger } from "../src/shared/logger.js";

const logger = { child: () => logger, info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger;

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
    assert.equal(token, "Bearer test-token");
    assert.deepEqual(body, { group_id: 42, count: 2, message_id: 7 });
    return { status: "ok", retcode: 0, data: { messages: [] } };
  }, async (endpoint) => {
    const client = new OneBotClient({ websocketEndpoint: "ws://127.0.0.1:1", apiEndpoint: endpoint, accessToken: "test-token", reconnectMs: 10, requestTimeoutMs: 1000 }, logger);
    assert.deepEqual(await client.action("get_group_msg_history", { group_id: 42, count: 2, message_id: 7 }), { messages: [] });
  });

  await withHttpServer(() => ({ status: "failed", retcode: 1200, data: null, wording: "message not found" }), async (endpoint) => {
    const client = new OneBotClient({ websocketEndpoint: "ws://127.0.0.1:1", apiEndpoint: endpoint, reconnectMs: 10, requestTimeoutMs: 1000 }, logger);
    await assert.rejects(() => client.action("get_msg", { message_id: 7 }), /ONEBOT_ACTION_FAILED:get_msg:message not found/);
  });
});

test("QQ history consumes SnowLuma data.messages and numeric IDs", async () => {
  await withHttpServer((path, body) => {
    assert.equal(path, "/get_group_msg_history");
    assert.deepEqual(body, { group_id: 42, count: 1 });
    return {
      status: "ok",
      retcode: 0,
      data: { messages: [{ message_id: 9, message_type: "group", group_id: 42, user_id: 8, time: 1, message: [{ type: "text", data: { text: "hello" } }] }] },
    };
  }, async (endpoint) => {
    const config = {
      instanceId: "test",
      owner: { platform: "qq", accountId: "default", userId: "8" },
      paths: { gatewayState: "./gateway.sqlite", pluginData: "./plugins", backupDir: "./backups", stateRoot: "/state", runtimeSocket: "/run/agent-home/control.sock" },
      snowluma: { accountId: "default", endpoint: "ws://127.0.0.1:1", apiEndpoint: endpoint, accessTokenEnv: "MISSING", reverseWebSocketPath: "/", reconnectMs: 10, requestTimeoutMs: 1000 },
      chat: { global: { commandRequireMention: false, naturalLanguageMode: "explicit_wake" as const }, qq: { commandRequireMention: false, naturalLanguageMode: "explicit_wake" as const }, conversationOverrides: {} },
      runtime: { maxInFlight: 2, maxWorkers: 1, maxArtifactBytes: 1000, piCommand: "pi", piTimeoutMs: 1000 },
      plugins: { enabled: [] },
      logging: { level: "error" as const },
    } as AppConfig;
    const adapter = new QQChatPlatformAdapter(config, logger);
    const events = await adapter.getRecentMessages({ conversation: { platform: "qq", accountId: "default", kind: "group", platformConversationId: "42", threadId: null }, limit: 1 });
    assert.equal(events.length, 1);
    assert.equal(events[0]?.message.text, "hello");
    assert.equal(events[0]?.message.ref.messageId, "9");
  });
});
