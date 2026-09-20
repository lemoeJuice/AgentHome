import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeApp } from "../src/runtime/runtime.js";
import type { AppConfig } from "../src/config.js";
import type { Logger } from "../src/shared/logger.js";

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
  await runtime.stop();
  await rm(root, { recursive: true, force: true });
});
