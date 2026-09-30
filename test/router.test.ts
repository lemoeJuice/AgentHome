import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Router } from "../src/gateway/router.js";
import { GatewayState } from "../src/gateway/state.js";
import { FilePluginState } from "../src/gateway/state.js";
import { GatewayArtifactService } from "../src/gateway/artifacts.js";
import { CommandRegistry, AgentActionRegistry } from "../src/gateway/registry.js";
import type { AppConfig } from "../src/config.js";
import type { ChatEvent, ChatPlatformAdapter, ConversationAddress, OutgoingMessage, SendResult } from "../src/shared/types.js";
import type { Logger } from "../src/shared/logger.js";
import { QQChatPlatformAdapter } from "../src/qq/adapter.js";

const logger = { child: () => logger, info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger;
const config = { instanceId: "x", owner: { platform: "qq", accountId: "a", userId: "owner" }, paths: { gatewayState: "/tmp/router-test.sqlite", pluginData: "/tmp/plugins", backupDir: "/tmp/backups", stateRoot: "/tmp/state", runtimeSocket: "/tmp/socket" }, snowluma: { accountId: "a", endpoint: "ws://localhost", apiEndpoint: "http://localhost", accessTokenEnv: "TOKEN", reverseWebSocketPath: "/ws", reconnectMs: 10, requestTimeoutMs: 10 }, chat: { global: { commandRequireMention: false, naturalLanguageMode: "explicit_wake" as const }, qq: { commandRequireMention: false, naturalLanguageMode: "explicit_wake" as const }, conversationOverrides: {} }, runtime: { maxInFlight: 2, maxWorkers: 1, maxArtifactBytes: 1000, piCommand: "pi", piTimeoutMs: 1000 }, plugins: { enabled: [] }, logging: { level: "error" as const } } as AppConfig;

class Adapter implements ChatPlatformAdapter {
  readonly platform = "qq";
  readonly sent: OutgoingMessage[] = [];
  fail = false;
  botMessageIds = new Set<string>();
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async sendMessage(target: ConversationAddress, message: OutgoingMessage): Promise<SendResult> { if (this.fail) throw new Error("OUTBOUND_UNAVAILABLE"); this.sent.push(message); return { message: { platform: "qq", accountId: target.accountId, platformConversationId: target.platformConversationId, threadId: target.threadId, messageId: `out-${this.sent.length}` } }; }
  async isReplyToBot(ref: import("../src/shared/types.js").PlatformMessageRef): Promise<boolean> { return this.botMessageIds.has(ref.messageId); }
}

test("Controller ingress contains only the summary and trusted message references", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-home-router-summary-"));
  const state = new GatewayState(join(root, "gateway.sqlite")); const adapter = new Adapter(); let delivered: unknown;
  const router = new Router(config, adapter, state, new CommandRegistry(), new AgentActionRegistry(), { deliver: async (event) => { delivered = event; } }, logger);
  const incoming = event("@bot inspect", "group", true);
  incoming.message.attachments = [{ type: "image", id: "image-id", url: "https://platform.invalid/image" }];
  await router.handle(incoming);
  const envelope = delivered as { payload: Record<string, unknown>; message: { ref: unknown; replyTo: unknown } };
  assert.deepEqual(envelope.payload, { text: "@bot inspect [图片]" });
  assert.equal(JSON.stringify(envelope).includes("image-id"), false);
  assert.equal(JSON.stringify(envelope).includes("platform.invalid"), false);
  assert.deepEqual(envelope.message.ref, incoming.message.ref);
  assert.equal(envelope.message.replyTo, null);
  state.close(); await rm(root, { recursive: true, force: true });
});

function event(text: string, kind: "private" | "group" = "private", mentionsBot: boolean = false, accountId = "a", platformConversationId?: string): ChatEvent {
  const conversation = { platform: "qq", accountId, kind, platformConversationId: platformConversationId ?? (kind === "group" ? "g" : "u"), threadId: null } as const;
  return { platform: "qq", accountId, sender: { platform: "qq", accountId, userId: "u" }, conversation, message: { ref: { ...conversation, messageId: `in-${Date.now()}-${Math.random()}` }, text, replyTo: null, mentionsBot, attachments: [] }, timestamp: new Date().toISOString() };
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

test("admin model commands are restricted to the configured Owner, not to private chat", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-home-router-admin-model-"));
  const state = new GatewayState(join(root, "gateway.sqlite"));
  const adapter = new Adapter();
  let executions = 0;
  const commands = new CommandRegistry();
  commands.register({ name: "model", permission: "admin", kind: "CORE" }, async () => { executions++; return { text: "model status" }; });
  const router = new Router(config, adapter, state, commands, new AgentActionRegistry(), { deliver: async () => {} }, logger);
  await router.handle(event("/model"));
  assert.equal(executions, 0);
  assert.match(adapter.sent[0]?.text ?? "", /没有执行此命令的权限/);
  const ownerEvent = event("/model");
  ownerEvent.sender.userId = "owner";
  await router.handle(ownerEvent);
  assert.equal(executions, 1);
  assert.equal(adapter.sent[1]?.text, "model status");
  const ownerGroupEvent = event("/model", "group", false);
  ownerGroupEvent.sender.userId = "owner";
  await router.handle(ownerGroupEvent);
  assert.equal(executions, 2);
  assert.equal(adapter.sent[2]?.text, "model status");
  state.close(); await rm(root, { recursive: true, force: true });
});

test("System Admin and legacy Owner command allowlists can be independent", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-home-router-system-admin-"));
  const state = new GatewayState(join(root, "gateway.sqlite"));
  const adapter = new Adapter();
  let executions = 0;
  const commands = new CommandRegistry();
  commands.register({ name: "admin-op", permission: "admin", kind: "CORE" }, async () => { executions++; return { text: "admin ok" }; });
  commands.register({ name: "owner-op", permission: "owner", kind: "CORE" }, async () => { executions++; return { text: "owner ok" }; });
  const isolatedConfig = { ...config, systemAdmins: [{ platform: "qq", accountId: "a", userId: "administrator" }] };
  const router = new Router(isolatedConfig, adapter, state, commands, new AgentActionRegistry(), { deliver: async () => {} }, logger);
  const ownerAdminAttempt = event("/admin-op"); ownerAdminAttempt.sender.userId = "owner";
  await router.handle(ownerAdminAttempt);
  assert.equal(executions, 0);
  const adminEvent = event("/admin-op"); adminEvent.sender.userId = "administrator";
  await router.handle(adminEvent);
  assert.equal(executions, 1);
  const adminOwnerAttempt = event("/owner-op"); adminOwnerAttempt.sender.userId = "administrator";
  await router.handle(adminOwnerAttempt);
  assert.equal(executions, 1);
  const ownerEvent = event("/owner-op"); ownerEvent.sender.userId = "owner";
  await router.handle(ownerEvent);
  assert.equal(executions, 2);
  state.close(); await rm(root, { recursive: true, force: true });
});

test("help lists runtime and Gateway commands and reports the active @ rule", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-home-router-help-"));
  const state = new GatewayState(join(root, "gateway.sqlite"));
  const adapter = new Adapter();
  const commands = new CommandRegistry();
  commands.register({ name: "model", aliases: ["models"], permission: "admin", kind: "CORE" }, async () => ({ text: "" }));
  commands.register({ name: "echo", aliases: ["say"], permission: "command.echo", kind: "PLUGIN" }, async () => ({ text: "" }));
  const router = new Router(config, adapter, state, commands, new AgentActionRegistry(), { deliver: async () => {} }, logger);
  await router.handle(event("/help", "group", false));
  assert.match(adapter.sent[0]?.text ?? "", /\/status/);
  assert.match(adapter.sent[0]?.text ?? "", /\/model set <provider> <model>/);
  assert.match(adapter.sent[0]?.text ?? "", /\/echo.*\/say/);
  assert.match(adapter.sent[0]?.text ?? "", /群聊命令不需要 @机器人/);
  state.close();

  const mentionState = new GatewayState(join(root, "mention-gateway.sqlite"));
  const mentionAdapter = new Adapter();
  const mentionConfig = { ...config, chat: { ...config.chat, qq: { ...config.chat.qq, commandRequireMention: true } } } as AppConfig;
  const mentionRouter = new Router(mentionConfig, mentionAdapter, mentionState, new CommandRegistry(), new AgentActionRegistry(), { deliver: async () => {} }, logger);
  await mentionRouter.handle(event("/help", "group", false));
  assert.equal(mentionAdapter.sent.length, 0);
  await mentionRouter.handle(event("@bot /help", "group", true));
  assert.match(mentionAdapter.sent[0]?.text ?? "", /群聊命令需要 @机器人/);
  mentionState.close();
  await rm(root, { recursive: true, force: true });
});

test("group explicit wake policy does not forward unmentioned messages", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-home-router-"));
  const state = new GatewayState(join(root, "gateway.sqlite")); const adapter = new Adapter(); const events: unknown[] = [];
  const router = new Router(config, adapter, state, new CommandRegistry(), new AgentActionRegistry(), { deliver: async (event) => events.push(event) }, logger);
  await router.handle(event("hello group", "group", false)); await router.handle(event("@bot hello", "group", true));
  assert.equal(events.length, 1);
  state.close(); await rm(root, { recursive: true, force: true });
});

test("group replies wake only when the quoted message belongs to the bot", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-home-router-reply-wake-"));
  const state = new GatewayState(join(root, "gateway.sqlite")); const adapter = new Adapter(); const events: unknown[] = [];
  adapter.botMessageIds.add("bot-message");
  const router = new Router(config, adapter, state, new CommandRegistry(), new AgentActionRegistry(), { deliver: async (event) => events.push(event) }, logger);
  const quotedUserMessage = event("reply to user", "group");
  quotedUserMessage.message.replyTo = { ...quotedUserMessage.message.ref, messageId: "user-message" };
  const quotedBotMessage = event("reply to bot", "group");
  quotedBotMessage.message.replyTo = { ...quotedBotMessage.message.ref, messageId: "bot-message" };
  await router.handle(quotedUserMessage);
  await router.handle(quotedBotMessage);
  assert.equal(events.length, 1);
  state.close(); await rm(root, { recursive: true, force: true });
});

test("wake policy namespaces the same conversation ID by account", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-home-router-scope-"));
  const state = new GatewayState(join(root, "gateway.sqlite")); const adapter = new Adapter(); const events: unknown[] = [];
  const scopedConfig = { ...config, chat: { ...config.chat, accountOverrides: { "qq\u001fa": { naturalLanguageMode: "explicit_wake" as const }, "qq\u001fb": { naturalLanguageMode: "observe_all" as const } } } } as AppConfig;
  const router = new Router(scopedConfig, adapter, state, new CommandRegistry(), new AgentActionRegistry(), { deliver: async (event) => events.push(event) }, logger);
  await router.handle(event("hello", "group", false, "a"));
  await router.handle(event("hello", "group", false, "b"));
  assert.equal(events.length, 1);
  state.close(); await rm(root, { recursive: true, force: true });
});

test("direct command outbound intent replays after delivery failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-home-router-replay-"));
  const state = new GatewayState(join(root, "gateway.sqlite")); const adapter = new Adapter(); adapter.fail = true;
  const commands = new CommandRegistry(); commands.register({ name: "echo", permission: "command.echo", kind: "PLUGIN" }, async (ctx) => ({ text: ctx.args.join(" ") }));
  const router = new Router(config, adapter, state, commands, new AgentActionRegistry(), { deliver: async () => {} }, logger);
  await router.handle(event("/echo retry"));
  assert.equal(state.store.get<{ status: string }>("SELECT status FROM command_invocations LIMIT 1")?.status, "COMPLETED");
  assert.equal(state.store.get<{ status: string }>("SELECT status FROM gateway_outbound_intents LIMIT 1")?.status, "PENDING");
  adapter.fail = false;
  await router.replayPendingOutbound();
  assert.equal(state.store.get<{ status: string }>("SELECT status FROM gateway_outbound_intents LIMIT 1")?.status, "SENT");
  assert.equal(adapter.sent[0]?.text, "retry");
  state.close(); await rm(root, { recursive: true, force: true });
});

test("permitted Gateway Artifact is transferred to the platform adapter", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-home-router-artifact-"));
  const state = new GatewayState(join(root, "gateway.sqlite")); const adapter = new Adapter();
  const pluginRoot = join(root, "plugin"); await mkdir(pluginRoot);
  const artifacts = new GatewayArtifactService(state.store, join(root, "gateway.sqlite"), logger, { baseUrl: "http://127.0.0.1:1", secret: "secret" });
  const commands = new CommandRegistry();
  commands.register({ name: "report", permission: "command.report", kind: "PLUGIN" }, async () => {
    const path = join(pluginRoot, "report.txt"); await writeFile(path, "report");
    return { artifacts: [{ ref: { authority: "bot-gateway", artifactId: "local" }, filename: "report.txt", mime: "text/plain", size: 6, path }] };
  }, new FilePluginState(pluginRoot));
  const router = new Router(config, adapter, state, commands, new AgentActionRegistry(), { deliver: async () => {} }, logger, artifacts);
  await router.handle(event("/report"));
  assert.equal(adapter.sent[0]?.attachments?.[0]?.artifact?.authority, "bot-gateway");
  assert.match(adapter.sent[0]?.attachments?.[0]?.url ?? "", /^http:\/\/127\.0\.0\.1:1\/artifact\//);
  state.close(); await rm(root, { recursive: true, force: true });
});

test("production Gateway artifacts use inline OneBot data without a Host transfer server", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-home-router-inline-artifact-"));
  const state = new GatewayState(join(root, "gateway.sqlite")); const adapter = new Adapter();
  const pluginRoot = join(root, "plugin"); await mkdir(pluginRoot);
  const artifacts = new GatewayArtifactService(state.store, join(root, "gateway.sqlite"), logger);
  const commands = new CommandRegistry();
  commands.register({ name: "inline-report", permission: "command.inline-report", kind: "PLUGIN" }, async () => {
    const path = join(pluginRoot, "report.txt"); await writeFile(path, "report");
    return { artifacts: [{ ref: { authority: "bot-gateway", artifactId: "local" }, filename: "report.txt", mime: "text/plain", size: 6, path }] };
  }, new FilePluginState(pluginRoot));
  const router = new Router(config, adapter, state, commands, new AgentActionRegistry(), { deliver: async () => {} }, logger, artifacts);
  await router.handle(event("/inline-report"));
  assert.equal(adapter.sent[0]?.attachments?.[0]?.url, "base64://cmVwb3J0");
  assert.equal(artifacts.hasTransfer(), false);
  state.close(); await rm(root, { recursive: true, force: true });
});

test("foreign Gateway Artifact authorities are rejected before enqueue", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-home-router-foreign-artifact-"));
  const state = new GatewayState(join(root, "gateway.sqlite"));
  const adapter = new Adapter();
  const commands = new CommandRegistry();
  commands.register({ name: "foreign", permission: "command.foreign", kind: "PLUGIN" }, async () => ({ artifacts: [{ ref: { authority: "agent-home", artifactId: "foreign" }, filename: "foreign.txt", size: 1 }] }));
  const router = new Router(config, adapter, state, commands, new AgentActionRegistry(), { deliver: async () => {} }, logger);
  await router.handle(event("/foreign"));
  assert.equal(state.store.get<{ status: string }>("SELECT status FROM command_invocations LIMIT 1")?.status, "FAILED");
  assert.equal(state.store.get("SELECT 1 FROM gateway_outbound_intents"), undefined);
  state.close(); await rm(root, { recursive: true, force: true });
});

test("expired Gateway Artifact intent becomes terminal instead of replaying forever", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-home-router-expired-artifact-"));
  const state = new GatewayState(join(root, "gateway.sqlite"));
  const adapter = new Adapter(); adapter.fail = true;
  const artifacts = new GatewayArtifactService(state.store, join(root, "gateway.sqlite"), logger, { baseUrl: "http://127.0.0.1:1", secret: "secret" });
  const pluginRoot = join(root, "plugin"); await mkdir(pluginRoot); await writeFile(join(pluginRoot, "expired.txt"), "expired");
  const commands = new CommandRegistry();
  commands.register({ name: "expired", permission: "command.expired", kind: "PLUGIN" }, async () => ({ artifacts: [{ ref: { authority: "bot-gateway", artifactId: "placeholder" }, filename: "expired.txt", size: 7, path: join(pluginRoot, "expired.txt") }] }), new FilePluginState(pluginRoot));
  const router = new Router(config, adapter, state, commands, new AgentActionRegistry(), { deliver: async () => {} }, logger, artifacts);
  await router.handle(event("/expired"));
  const artifact = state.store.get<{ id: string }>("SELECT id FROM gateway_artifacts LIMIT 1")!;
  state.store.run("UPDATE gateway_artifacts SET expires_at=? WHERE id=?", "2020-01-01T00:00:00.000Z", artifact.id);
  adapter.fail = false;
  await router.replayPendingOutbound();
  assert.equal(state.store.get<{ status: string }>("SELECT status FROM gateway_outbound_intents LIMIT 1")?.status, "FAILED");
  state.close(); await rm(root, { recursive: true, force: true });
});

test("Gateway Artifact reaches the real OneBot HTTP send path", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-home-router-live-artifact-"));
  const state = new GatewayState(join(root, "gateway.sqlite"));
  const pluginRoot = join(root, "plugin"); await mkdir(pluginRoot); await writeFile(join(pluginRoot, "report.txt"), "gateway through qq");
  let transferred = "";
  const onebot = createServer(async (request, response) => {
    let input = ""; for await (const chunk of request) input += String(chunk);
    const body = input ? JSON.parse(input) as Record<string, unknown> : {};
    if (request.url === "/send_private_msg") {
      const message = body.message as Array<{ data?: { file?: string } }>;
      const file = message?.find((segment) => segment.data?.file)?.data?.file;
      assert.ok(file);
      const artifactResponse = await fetch(file!);
      assert.equal(artifactResponse.status, 200);
      transferred = await artifactResponse.text();
    }
    response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ status: "ok", retcode: 0, data: { message_id: 99 } }));
  });
  await new Promise<void>((resolve) => onebot.listen(0, "127.0.0.1", resolve));
  const address = onebot.address(); assert.ok(address && typeof address !== "string");
  const artifacts = new GatewayArtifactService(state.store, join(root, "gateway.sqlite"), logger, { baseUrl: "http://127.0.0.1:0", secret: "secret", port: 0, host: "127.0.0.1" });
  const liveConfig = { ...config, snowluma: { ...config.snowluma, apiEndpoint: `http://127.0.0.1:${address.port}`, requestTimeoutMs: 1000 } } as AppConfig;
  const adapter = new QQChatPlatformAdapter(liveConfig, logger);
  const commands = new CommandRegistry();
  commands.register({ name: "live-report", permission: "command.live-report", kind: "PLUGIN" }, async () => ({ artifacts: [{ ref: { authority: "bot-gateway", artifactId: "placeholder" }, filename: "report.txt", mime: "text/plain", size: 19, path: join(pluginRoot, "report.txt") }] }), new FilePluginState(pluginRoot));
  const router = new Router(liveConfig, adapter, state, commands, new AgentActionRegistry(), { deliver: async () => {} }, logger, artifacts);
  await artifacts.start();
  try {
    await router.handle(event("/live-report", "private", false, "a", "8"));
    assert.equal(transferred, "gateway through qq");
  } finally {
    await artifacts.stop(); state.close(); await new Promise<void>((resolve) => onebot.close(() => resolve())); await rm(root, { recursive: true, force: true });
  }
});
