import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Router } from "../src/gateway/router.js";
import { GatewayState } from "../src/gateway/state.js";
import { CommandRegistry, AgentActionRegistry } from "../src/gateway/registry.js";
import type { AppConfig } from "../src/config.js";
import type { ChatEvent, ChatPlatformAdapter, ConversationAddress, OutgoingMessage, SendResult } from "../src/shared/types.js";
import type { Logger } from "../src/shared/logger.js";

const logger = { child: () => logger, info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger;
const config = { instanceId: "x", owner: { platform: "qq", accountId: "a", userId: "owner" }, paths: { gatewayState: "/tmp/router-test.sqlite", pluginData: "/tmp/plugins", backupDir: "/tmp/backups", stateRoot: "/tmp/state", runtimeSocket: "/tmp/socket" }, snowluma: { accountId: "a", endpoint: "ws://localhost", apiEndpoint: "http://localhost", accessTokenEnv: "TOKEN", reverseWebSocketPath: "/ws", reconnectMs: 10, requestTimeoutMs: 10 }, chat: { global: { commandRequireMention: false, naturalLanguageMode: "explicit_wake" as const }, qq: { commandRequireMention: false, naturalLanguageMode: "explicit_wake" as const }, conversationOverrides: {} }, runtime: { maxInFlight: 2, maxWorkers: 1, maxArtifactBytes: 1000, piCommand: "pi", piTimeoutMs: 1000 }, plugins: { enabled: [] }, logging: { level: "error" as const } } as AppConfig;

class Adapter implements ChatPlatformAdapter {
  readonly platform = "qq";
  readonly sent: OutgoingMessage[] = [];
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async sendMessage(target: ConversationAddress, message: OutgoingMessage): Promise<SendResult> { this.sent.push(message); return { message: { platform: "qq", accountId: target.accountId, platformConversationId: target.platformConversationId, threadId: target.threadId, messageId: `out-${this.sent.length}` } }; }
  async getMessage(): Promise<null> { return null; }
  async getRecentMessages(): Promise<[]> { return []; }
  async fetchAttachment(): Promise<never> { throw new Error("not used"); }
}

function event(text: string, kind: "private" | "group" = "private", mentionsBot: boolean = false): ChatEvent {
  const conversation = { platform: "qq", accountId: "a", kind, platformConversationId: kind === "group" ? "g" : "u", threadId: null } as const;
  return { platform: "qq", accountId: "a", sender: { platform: "qq", accountId: "a", userId: "u" }, conversation, message: { ref: { ...conversation, messageId: `in-${Date.now()}-${Math.random()}` }, text, replyTo: null, mentionsBot, attachments: [] }, timestamp: new Date().toISOString() };
}

test("direct plugin command bypasses Controller and Main", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-home-router-"));
  const state = new GatewayState(join(root, "gateway.sqlite"));
  const adapter = new Adapter(); const controllerEvents: unknown[] = [];
  const commands = new CommandRegistry(); commands.register({ name: "echo", permission: "command.echo", kind: "PLUGIN" }, async (ctx) => ({ text: ctx.args.join(" "), context: { type: "echo", summary: "ok" } }));
  const router = new Router(config, adapter, state, commands, new AgentActionRegistry(), { deliver: async (event) => { controllerEvents.push(event); } }, logger);
  await router.handle(event("/echo hello"));
  assert.equal(adapter.sent[0]?.text, "hello"); assert.equal(controllerEvents.length, 0);
  assert.equal(state.store.get<{ status: string }>("SELECT status FROM command_invocations LIMIT 1")?.status, "COMPLETED");
  state.close(); await rm(root, { recursive: true, force: true });
});

test("group explicit wake policy does not forward unmentioned messages", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-home-router-"));
  const state = new GatewayState(join(root, "gateway.sqlite")); const adapter = new Adapter(); const events: unknown[] = [];
  const router = new Router(config, adapter, state, new CommandRegistry(), new AgentActionRegistry(), { deliver: async (event) => events.push(event) }, logger);
  await router.handle(event("hello group", "group", false)); await router.handle(event("@bot hello", "group", true));
  assert.equal(events.length, 1);
  state.close(); await rm(root, { recursive: true, force: true });
});
