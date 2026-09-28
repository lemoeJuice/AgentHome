import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, snowlumaAccessToken, snowlumaWebSocketAccessToken } from "../src/config.ts";

test("loadConfig reads multiple Bot Owner identities from the main config", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-home-config-"));
  const configPath = join(root, "agent-home.json");
  try {
    await writeFile(configPath, JSON.stringify({ instanceId: "config-test", owners: [{ platform: "qq", accountId: "bot-1", userId: "owner-1" }, { platform: "qq", accountId: "bot-1", userId: "owner-2" }], snowluma: { endpoint: "ws://snowluma", apiEndpoint: "http://snowluma" } }));
    const config = await loadConfig(configPath);
    assert.deepEqual(config.owners, [{ platform: "qq", accountId: "bot-1", userId: "owner-1" }, { platform: "qq", accountId: "bot-1", userId: "owner-2" }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("loadConfig accepts an unconfigured deployment without an Owner", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-home-config-no-owner-"));
  const configPath = join(root, "agent-home.json");
  try {
    await writeFile(configPath, JSON.stringify({ instanceId: "config-no-owner", snowluma: { endpoint: "ws://snowluma", apiEndpoint: "http://snowluma" } }));
    const config = await loadConfig(configPath);
    assert.equal(config.owners, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("loadConfig preserves array values while merging defaults", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-home-config-array-"));
  const configPath = join(root, "agent-home.json");
  try {
    await writeFile(configPath, JSON.stringify({ instanceId: "config-array", plugins: { enabled: ["./dist/plugins/echo.js"] }, snowluma: { endpoint: "ws://snowluma", apiEndpoint: "http://snowluma" } }));
    const config = await loadConfig(configPath);
    assert.deepEqual(config.plugins.enabled, ["./dist/plugins/echo.js"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Pi auth default follows stateRoot and migrates the legacy Owner auth path", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-home-config-model-plane-"));
  const configPath = join(root, "agent-home.json");
  try {
    await writeFile(configPath, JSON.stringify({ instanceId: "model-plane-config", paths: { stateRoot: root }, snowluma: { endpoint: "ws://snowluma", apiEndpoint: "http://snowluma" } }));
    assert.equal((await loadConfig(configPath)).runtime.piAgentDir, join(root, "model", "pi", "agent"));
    await writeFile(configPath, JSON.stringify({ instanceId: "model-plane-config", paths: { stateRoot: root }, runtime: { piAgentDir: join(root, "home", ".pi", "agent") }, snowluma: { endpoint: "ws://snowluma", apiEndpoint: "http://snowluma" } }));
    assert.equal((await loadConfig(configPath)).runtime.piAgentDir, join(root, "model", "pi", "agent"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("legacy 2 GiB guest address-space default is raised for Node 22 WebAssembly", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-home-config-node-rlimit-"));
  const configPath = join(root, "agent-home.json");
  try {
    await writeFile(configPath, JSON.stringify({ instanceId: "node-rlimit", paths: { stateRoot: root }, guest: { enabled: true, memoryBytes: 2147483648 }, snowluma: { endpoint: "ws://snowluma", apiEndpoint: "http://snowluma" } }));
    assert.equal((await loadConfig(configPath)).guest.memoryBytes, 17179869184);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("loadConfig reads the configurable Main persona", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-home-config-persona-"));
  const configPath = join(root, "agent-home.json");
  try {
    await writeFile(configPath, JSON.stringify({ instanceId: "config-persona", agent: { persona: "Be concise and gentle." }, snowluma: { endpoint: "ws://snowluma", apiEndpoint: "http://snowluma" } }));
    const config = await loadConfig(configPath);
    assert.equal(config.agent.persona, "Be concise and gentle.");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("loadConfig exposes gateway and network endpoints as deployment settings", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-home-config-network-"));
  const configPath = join(root, "agent-home.json");
  try {
    await writeFile(configPath, JSON.stringify({ instanceId: "config-network", gateway: { mcpPort: 9123, mcpHost: "127.0.0.1", mcpActionTimeoutMs: 45000 }, network: { modelProxyUrl: "http://proxy.internal:8080" }, snowluma: { endpoint: "ws://snowluma", apiEndpoint: "http://snowluma" } }));
    const config = await loadConfig(configPath);
    assert.deepEqual(config.gateway, { mcpPort: 9123, mcpHost: "127.0.0.1", mcpActionTimeoutMs: 45000 });
    assert.equal(config.network.modelProxyUrl, "http://proxy.internal:8080");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("loadConfig merges and validates SnowLuma container deployment settings", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-home-snowluma-deployment-config-"));
  const configPath = join(root, "config.json");
  try {
    await writeFile(configPath, JSON.stringify({
      instanceId: "snowluma-deployment-config",
      snowluma: {
        endpoint: "ws://snowluma",
        apiEndpoint: "http://snowluma",
        deployment: { serviceBindAddress: "127.0.0.2", httpPort: 3100, acceptEula: false },
      },
    }));
    const config = await loadConfig(configPath);
    assert.deepEqual(config.snowluma.deployment, {
      serviceBindAddress: "127.0.0.2",
      uiBindAddress: "0.0.0.0",
      httpPort: 3100,
      wsPort: 3001,
      webuiPort: 5100,
      novncPort: 6081,
      acceptEula: false,
      acceptPrivacy: true,
    });
    await writeFile(configPath, JSON.stringify({
      instanceId: "snowluma-deployment-config",
      snowluma: { endpoint: "ws://snowluma", apiEndpoint: "http://snowluma", deployment: { wsPort: 70000 } },
    }));
    await assert.rejects(loadConfig(configPath), /CONFIG_INVALID: snowluma\.deployment\.wsPort/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("loadConfig derives the container proxy endpoint from configurable relay ports", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-home-proxy-relay-config-"));
  const configPath = join(root, "agent-home.json");
  try {
    await writeFile(configPath, JSON.stringify({ instanceId: "proxy-relay-config", network: { proxyRelay: { enabled: true, listenPort: 18990, upstreamHost: "127.0.0.1", upstreamPort: 7892 } }, snowluma: { endpoint: "ws://snowluma", apiEndpoint: "http://snowluma" } }));
    const config = await loadConfig(configPath);
    assert.equal(config.network.modelProxyUrl, "http://host.containers.internal:18990");
    assert.deepEqual(config.network.proxyRelay, { enabled: true, listenPort: 18990, upstreamHost: "127.0.0.1", upstreamPort: 7892 });
    await writeFile(configPath, JSON.stringify({ instanceId: "proxy-relay-config", network: { proxyRelay: { enabled: false, listenPort: 18990, upstreamHost: "127.0.0.1", upstreamPort: 7892 } }, snowluma: { endpoint: "ws://snowluma", apiEndpoint: "http://snowluma" } }));
    assert.equal((await loadConfig(configPath)).network.modelProxyUrl, undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("loadConfig defaults the host proxy relay to Mihomo's HTTP port", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-home-proxy-relay-default-"));
  const configPath = join(root, "agent-home.json");
  try {
    await writeFile(configPath, JSON.stringify({ instanceId: "proxy-relay-default", snowluma: { endpoint: "ws://snowluma", apiEndpoint: "http://snowluma" } }));
    assert.equal((await loadConfig(configPath)).network.proxyRelay.upstreamPort, 7897);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("loadConfig validates proxy relay ports and upstream host", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-home-proxy-relay-invalid-"));
  const configPath = join(root, "agent-home.json");
  try {
    await writeFile(configPath, JSON.stringify({ instanceId: "proxy-relay-invalid", network: { proxyRelay: { listenPort: 70000, upstreamHost: "127.0.0.1", upstreamPort: 7890 } }, snowluma: { endpoint: "ws://snowluma", apiEndpoint: "http://snowluma" } }));
    await assert.rejects(loadConfig(configPath), /CONFIG_INVALID: network\.proxyRelay\.listenPort/);
    await writeFile(configPath, JSON.stringify({ instanceId: "proxy-relay-invalid", network: { proxyRelay: { listenPort: 17890, upstreamHost: "bad host", upstreamPort: 7890 } }, snowluma: { endpoint: "ws://snowluma", apiEndpoint: "http://snowluma" } }));
    await assert.rejects(loadConfig(configPath), /CONFIG_INVALID: network\.proxyRelay\.upstreamHost/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("SnowLuma credentials are read only from private state", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-home-config-secret-"));
  try {
    await mkdir(join(root, "secrets"));
    await writeFile(join(root, "secrets/snowluma-access-token"), "access-token\n");
    await writeFile(join(root, "secrets/snowluma-websocket-access-token"), "websocket-token\n");
    const config = { paths: { stateRoot: root }, snowluma: {} } as Awaited<ReturnType<typeof loadConfig>>;
    assert.equal(snowlumaAccessToken(config), "access-token");
    assert.equal(snowlumaWebSocketAccessToken(config), "websocket-token");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("host Gateway can read the private deployment secret without container state", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-home-host-secret-"));
  const previous = process.env.AGENT_HOME_HOST_SECRET_ROOT;
  try {
    await writeFile(join(root, "snowluma-access-token"), "host-access-token\n");
    process.env.AGENT_HOME_HOST_SECRET_ROOT = root;
    const config = { paths: { stateRoot: join(root, "missing-state") }, snowluma: {} } as Awaited<ReturnType<typeof loadConfig>>;
    assert.equal(snowlumaAccessToken(config), "host-access-token");
  } finally {
    if (previous === undefined) delete process.env.AGENT_HOME_HOST_SECRET_ROOT;
    else process.env.AGENT_HOME_HOST_SECRET_ROOT = previous;
    await rm(root, { recursive: true, force: true });
  }
});
