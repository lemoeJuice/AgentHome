import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, snowlumaAccessToken, snowlumaWebSocketAccessToken } from "../src/config.ts";

test("loadConfig reads Bot Owner identity from the separate owner config", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-home-config-"));
  const configPath = join(root, "agent-home.json");
  try {
    await writeFile(configPath, JSON.stringify({ instanceId: "config-test", snowluma: { endpoint: "ws://snowluma", apiEndpoint: "http://snowluma" } }));
    await writeFile(join(root, "owner.json"), JSON.stringify({ platform: "qq", accountId: "bot-1", userId: "owner-1" }));
    const config = await loadConfig(configPath);
    assert.deepEqual(config.owner, { platform: "qq", accountId: "bot-1", userId: "owner-1" });
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
    assert.equal(config.owner, undefined);
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
