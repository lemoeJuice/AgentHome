import test from "node:test";
import assert from "node:assert/strict";
import { AgentActionRegistry } from "../src/gateway/registry.ts";
import { GatewayMcpServer } from "../src/gateway/mcp.ts";
import { Logger } from "../src/shared/logger.ts";
import { GatewayMcpClient } from "../src/runtime/mcp.ts";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SnowLumaMcpClient } from "../src/runtime/snowluma-mcp.ts";

test("Gateway MCP requires auth and binds Worker actions to the server-side Task", async () => {
  const actions = new AgentActionRegistry();
  actions.register({ name: "project.read", description: "read project", permission: "project.read", inputSchema: { type: "object" }, pluginId: "test" }, async (input, context) => ({ input, context }));
  actions.register({ name: "project.write", description: "write project", permission: "project.write", inputSchema: { type: "object" }, pluginId: "test" }, async (input, context) => ({ input, context }));
  const server = new GatewayMcpServer(actions, 0, new Logger("test", "error"), { host: "127.0.0.1", token: "main-token", workerBindings: { "worker-token": { taskId: "task-1", workerId: "worker-1", allowedActions: ["project.read"], allowedPermissions: ["project.read"] }, "worker-token-2": { taskId: "task-2", workerId: "worker-2", allowedActions: ["project.read"], allowedPermissions: ["project.read"] } }, allowedActions: ["project.read"], allowedPermissions: ["project.read"] });
  await server.start();
  try {
    const url = `http://127.0.0.1:${server.getPort()}/mcp`;
    const initialize = await fetch(url, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer worker-token" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } } }) });
    assert.equal(initialize.status, 200);
    assert.equal(((await initialize.json() as { result: { serverInfo: { name: string } } }).result.serverInfo.name), "agent-home-gateway");
    const tools = await fetch(url, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer worker-token" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) });
    assert.ok(((await tools.json() as { result: { tools: Array<{ name: string }> } }).result.tools).some((tool) => tool.name === "invoke_action"));
    const call = async (token: string | undefined, params: Record<string, unknown>) => {
      const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "invoke_action", params }) });
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    };
    assert.equal((await call(undefined, { name: "project.read", input: {} })).status, 401);
    const main = await call("main-token", { name: "project.read", taskId: "forged-task", input: { ok: true }, capabilities: { projects: ["*"] } });
    assert.equal(main.status, 200);
    assert.equal(((main.body.result as { context: { taskId?: string } }).context.taskId), undefined);
    const forged = await call("worker-token", { name: "project.read", taskId: "forged-task", input: {} });
    assert.equal(forged.status, 200);
    assert.equal(((forged.body.result as { context: { taskId?: string } }).context.taskId), "task-1");
    const worker = await call("worker-token", { name: "project.read", taskId: "task-1", input: { ok: true }, capabilities: { projects: ["*"] } });
    assert.equal(worker.status, 200);
    assert.equal(((worker.body.result as { context: { taskId?: string } }).context.taskId), "task-1");
    const deniedByTaskCapability = await call("worker-token", { name: "project.write", taskId: "task-1", input: {} });
    assert.equal(deniedByTaskCapability.status, 403);
    const secondWorker = await call("worker-token-2", { name: "project.read", taskId: "forged-task", input: {} });
    assert.equal(secondWorker.status, 200);
    assert.equal(((secondWorker.body.result as { context: { taskId?: string } }).context.taskId), "task-2");
    const client = new GatewayMcpClient({ endpoint: url, token: "worker-token", caller: "WORKER" });
    assert.deepEqual((await client.listActions()).map((action) => action.name), ["project.read"]);
    assert.equal((await client.getAction("project.read")).permission, "project.read");
    assert.equal((await client.invokeAction("project.read", { from: "runtime" }) as { context: { taskId?: string } }).context.taskId, "task-1");
    assert.equal((await new GatewayMcpClient({ endpoint: url, token: "worker-token", caller: "WORKER" }).invokeAction("project.read", {}) as { context: { taskId?: string } }).context.taskId, "task-1");
  } finally {
    await server.stop();
  }
});

test("SnowLuma MCP client speaks stdio JSON-RPC and unwraps OneBot envelopes", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-home-snowluma-mcp-"));
  const previousCommand = process.env.SNOWLUMA_MCP_COMMAND;
  const previousServer = process.env.SNOWLUMA_MCP_SERVER;
  const previousArgs = process.env.SNOWLUMA_MCP_ARGS;
  process.env.SNOWLUMA_MCP_COMMAND = process.execPath;
  process.env.SNOWLUMA_MCP_SERVER = join(process.cwd(), "test/fixtures/fake-snowluma-mcp.mjs");
  delete process.env.SNOWLUMA_MCP_ARGS;
  const config = {
    instanceId: "test",
    paths: { gatewayState: root, pluginData: root, backupDir: root, stateRoot: root, runtimeSocket: join(root, "runtime.sock") },
    snowluma: { accountId: "default", endpoint: "ws://127.0.0.1:1", apiEndpoint: "http://snowluma:3000", reverseWebSocketPath: "/onebot/v11/ws", reconnectMs: 10, requestTimeoutMs: 1000 },
    chat: { global: { commandRequireMention: false, naturalLanguageMode: "explicit_wake" as const }, qq: { commandRequireMention: false, naturalLanguageMode: "explicit_wake" as const }, conversationOverrides: {} },
    runtime: { maxInFlight: 1, maxWorkers: 1, maxArtifactBytes: 1000, piCommand: "pi", piTimeoutMs: 1000, workerSandboxCommand: "bwrap", piAgentDir: root },
    plugins: { enabled: [], allowedActions: [] },
    logging: { level: "error" as const },
  } as import("../src/config.ts").AppConfig;
  const logger = new Logger("snowluma-test", "error");
  const client = new SnowLumaMcpClient(config, logger);
  try {
    assert.deepEqual(await client.queryAction("get_msg", { message_id: 7 }), { action: "get_msg", params: { message_id: 7 } });
    assert.deepEqual(await client.invokeAction("send_private_msg", { user_id: 8 }), { message_id: 42 });
  } finally {
    await client.stop();
    await rm(root, { recursive: true, force: true });
    if (previousCommand === undefined) delete process.env.SNOWLUMA_MCP_COMMAND; else process.env.SNOWLUMA_MCP_COMMAND = previousCommand;
    if (previousServer === undefined) delete process.env.SNOWLUMA_MCP_SERVER; else process.env.SNOWLUMA_MCP_SERVER = previousServer;
    if (previousArgs === undefined) delete process.env.SNOWLUMA_MCP_ARGS; else process.env.SNOWLUMA_MCP_ARGS = previousArgs;
  }
});

test("Gateway MCP enforces permission scopes independently from action names", async () => {
  const actions = new AgentActionRegistry();
  actions.register({ name: "same-action", description: "write", permission: "project.write", inputSchema: { type: "object" }, pluginId: "test" }, async () => ({ ok: true }));
  const server = new GatewayMcpServer(actions, 0, new Logger("test", "error"), { host: "127.0.0.1", token: "main-token", allowedActions: ["same-action"], allowedPermissions: ["project.read"] });
  await server.start();
  try {
    const client = new GatewayMcpClient({ endpoint: `http://127.0.0.1:${server.getPort()}/mcp`, token: "main-token", caller: "MAIN" });
    assert.deepEqual(await client.listActions(), []);
    await assert.rejects(client.invokeAction("same-action", {}), /ACTION_DENIED/);
  } finally {
    await server.stop();
  }
});

test("Gateway Agent Actions have an invocation identity and timeout boundary", async () => {
  const actions = new AgentActionRegistry();
  actions.register({ name: "slow.action", description: "slow", permission: "slow.action", inputSchema: { type: "object" }, pluginId: "test" }, async (_input, context) => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    return context;
  });
  const server = new GatewayMcpServer(actions, 0, new Logger("test", "error"), { host: "127.0.0.1", token: "main-token", allowedActions: ["slow.action"], actionTimeoutMs: 5 });
  await server.start();
  try {
    const client = new GatewayMcpClient({ endpoint: `http://127.0.0.1:${server.getPort()}/mcp`, token: "main-token", caller: "MAIN" });
    await assert.rejects(client.invokeAction("slow.action", {}), /AGENT_ACTION_TIMEOUT/);
  } finally {
    await server.stop();
  }
});

test("Gateway MCP resolves multiple durable Worker bindings server-side", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-home-mcp-bindings-"));
  const bindingsPath = join(root, "worker-bindings.json");
  await writeFile(bindingsPath, JSON.stringify({
    "worker-token-1": { taskId: "task-1", workerId: "worker-1", allowedActions: ["project.read"], allowedPermissions: ["project.read"] },
    "worker-token-2": { taskId: "task-2", workerId: "worker-2", allowedActions: ["project.write"], allowedPermissions: ["project.write"] },
  }));
  const { JsonFileMcpWorkerCapabilityResolver } = await import("../src/gateway/mcp.ts");
  const actions = new AgentActionRegistry();
  actions.register({ name: "project.read", description: "read project", permission: "project.read", inputSchema: { type: "object" }, pluginId: "test" }, async (_input, context) => context);
  actions.register({ name: "project.write", description: "write project", permission: "project.write", inputSchema: { type: "object" }, pluginId: "test" }, async (_input, context) => context);
  const resolver = new JsonFileMcpWorkerCapabilityResolver(bindingsPath);
  const server = new GatewayMcpServer(actions, 0, new Logger("test", "error"), { host: "127.0.0.1", workerCapabilityResolver: resolver.resolve.bind(resolver) });
  await server.start();
  try {
    const url = `http://127.0.0.1:${server.getPort()}/mcp`;
    const call = async (token: string, name: string) => {
      const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "invoke_action", params: { name, taskId: "forged-task", capabilities: { projects: ["*"] }, input: {} } }) });
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    };
    const first = await call("worker-token-1", "project.read");
    assert.equal(first.status, 200);
    assert.deepEqual((first.body.result as { caller: string; requesterId: string; taskId: string; workerId: string }).caller, "WORKER");
    assert.equal((first.body.result as { requesterId: string }).requesterId, "mcp:worker:task-1");
    assert.equal((first.body.result as { taskId: string }).taskId, "task-1");
    assert.equal((first.body.result as { workerId: string }).workerId, "worker-1");
    assert.match((first.body.result as { invocationId: string }).invocationId, /^agent-action_/);
    const second = await call("worker-token-2", "project.write");
    assert.equal(second.status, 200);
    assert.equal((second.body.result as { taskId: string }).taskId, "task-2");
    assert.equal((second.body.result as { workerId: string }).workerId, "worker-2");
    assert.equal((await call("worker-token-1", "project.write")).status, 403);
    assert.equal((await call("unknown-token", "project.read")).status, 401);
  } finally {
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("Gateway MCP control capability manages durable Worker bindings", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-home-mcp-control-"));
  const workerBindingsPath = join(root, "worker-bindings.json");
  await writeFile(workerBindingsPath, "{}\n");
  const actions = new AgentActionRegistry();
  actions.register({ name: "project.read", description: "read project", permission: "project.read", inputSchema: { type: "object" }, pluginId: "test" }, async (_input, context) => context);
  const server = new GatewayMcpServer(actions, 0, new Logger("test", "error"), { host: "127.0.0.1", token: "main-token", controlToken: "control-token", workerBindingsPath });
  await server.start();
  try {
    const url = `http://127.0.0.1:${server.getPort()}/mcp`;
    const control = new GatewayMcpClient({ endpoint: url, token: "control-token", caller: "CONTROL" });
    await control.registerWorkerBinding({ token: "runtime-worker-token", taskId: "task-runtime", workerId: "worker-runtime", allowedActions: ["project.read"] });
    const worker = new GatewayMcpClient({ endpoint: url, token: "runtime-worker-token", caller: "WORKER" });
    const context = await worker.invokeAction("project.read", {}) as { caller: string; requesterId: string; taskId: string; workerId: string; invocationId: string };
    assert.deepEqual({ caller: context.caller, requesterId: context.requesterId, taskId: context.taskId, workerId: context.workerId }, { caller: "WORKER", requesterId: "mcp:worker:task-runtime", taskId: "task-runtime", workerId: "worker-runtime" });
    assert.match(context.invocationId, /^agent-action_/);
    assert.deepEqual(await control.unregisterWorkerBinding("runtime-worker-token"), { removed: true });
    await assert.rejects(worker.invokeAction("project.read", {}), /MCP_REQUEST_FAILED/);
  } finally {
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
});
