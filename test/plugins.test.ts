import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadPlugins } from "../src/gateway/plugins.ts";
import { AgentActionRegistry, CommandRegistry } from "../src/gateway/registry.ts";
import type { AppConfig } from "../src/config.ts";
import { Logger } from "../src/shared/logger.ts";

test("plugin registration failure is isolated and does not leave partial routes", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-home-plugins-"));
  try {
    const broken = join(root, "broken.mjs");
    const healthy = join(root, "healthy.mjs");
    await writeFile(broken, `export default (ctx) => { ctx.registerCommand({ name: "recovered", permission: "public" }, async () => ({ text: "bad" })); throw new Error("init failed"); };`);
    await writeFile(healthy, `export default (ctx) => { ctx.registerCommand({ name: "recovered", permission: "public" }, async () => ({ text: "ok" })); };`);

    const config = { plugins: { enabled: [broken, healthy] }, paths: { pluginData: join(root, "plugin-data") } } as AppConfig;
    const commands = new CommandRegistry();
    const actions = new AgentActionRegistry();
    const report = await loadPlugins(config, commands, actions, new Logger("test", "error"));

    assert.equal(report.failed.length, 1);
    assert.equal(report.failed[0]?.pluginId, "broken.mjs");
    assert.deepEqual(report.loaded, ["healthy.mjs"]);
    assert.equal((await commands.resolve("recovered")?.handler({} as never))?.text, "ok");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("plugin registry collision is isolated from later plugins and leaves no partial action", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-home-plugin-collision-"));
  try {
    const collision = join(root, "collision.mjs");
    const healthy = join(root, "healthy.mjs");
    await writeFile(collision, `export default (ctx) => { ctx.registerAgentAction({ name: "partial.action", description: "partial", inputSchema: {}, permission: "test" }, async () => null); ctx.registerCommand({ name: "occupied", permission: "public" }, async () => ({ text: "bad" })); };`);
    await writeFile(healthy, `export default (ctx) => { ctx.registerCommand({ name: "after-collision", permission: "public" }, async () => ({ text: "ok" })); };`);

    const config = { plugins: { enabled: [collision, healthy] }, paths: { pluginData: join(root, "plugin-data") } } as AppConfig;
    const commands = new CommandRegistry();
    commands.register({ name: "occupied", permission: "public", kind: "CORE" }, async () => ({ text: "core" }));
    const actions = new AgentActionRegistry();
    const report = await loadPlugins(config, commands, actions, new Logger("test", "error"));

    assert.equal(report.failed.length, 1);
    assert.deepEqual(report.loaded, ["healthy.mjs"]);
    assert.equal(actions.get("partial.action"), undefined);
    assert.ok(commands.resolve("after-collision"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("plugin shutdown aborts active commands and awaits registered cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-home-plugin-lifecycle-"));
  try {
    const modulePath = join(root, "lifecycle.mjs");
    await writeFile(modulePath, `export default (ctx) => {
      ctx.onDispose(() => { globalThis.__pluginDisposed = true; });
      ctx.registerCommand({ name: "wait", permission: "public" }, async (command) => new Promise((resolve) => {
        globalThis.__pluginStarted();
        command.signal.addEventListener("abort", () => resolve({ text: "aborted" }), { once: true });
      }));
    };`);
    Reflect.deleteProperty(globalThis, "__pluginDisposed");
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    globalThis.__pluginStarted = signalStarted;
    const config = { plugins: { enabled: [modulePath] }, paths: { pluginData: join(root, "plugin-data") } } as AppConfig;
    const commands = new CommandRegistry();
    const report = await loadPlugins(config, commands, new AgentActionRegistry(), new Logger("test", "error"));
    assert.deepEqual(report.failed, []);

    const route = commands.resolve("wait");
    assert.ok(route);
    const running = route.handler({} as never);
    await started;
    await commands.stopPlugins();
    assert.equal((await running).text, "aborted");
    assert.equal(globalThis.__pluginDisposed, true);
  } finally {
    Reflect.deleteProperty(globalThis, "__pluginDisposed");
    Reflect.deleteProperty(globalThis, "__pluginStarted");
    await rm(root, { recursive: true, force: true });
  }
});
