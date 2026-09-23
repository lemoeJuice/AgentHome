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
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async sendMessage(target: ConversationAddress, message: OutgoingMessage): Promise<SendResult> { if (this.fail) throw new Error("OUTBOUND_UNAVAILABLE"); this.sent.push(message); return { message: { platform: "qq", accountId: target.accountId, platformConversationId: target.platformConversationId, threadId: target.threadId, messageId: `out-${this.sent.length}` } }; }
  async getMessage(): Promise<null> { return null; }
  async getRecentMessages(): Promise<[]> { return []; }
  async fetchAttachment(): Promise<never> { throw new Error("not used"); }
}

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

test("group explicit wake policy does not forward unmentioned messages", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-home-router-"));
  const state = new GatewayState(join(root, "gateway.sqlite")); const adapter = new Adapter(); const events: unknown[] = [];
  const router = new Router(config, adapter, state, new CommandRegistry(), new AgentActionRegistry(), { deliver: async (event) => events.push(event) }, logger);
  await router.handle(event("hello group", "group", false)); await router.handle(event("@bot hello", "group", true));
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
