import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "../src/db.js";

test("bootstrap initializes private state and schema without provider credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-home-bootstrap-"));
  try {
    const child = spawn(process.execPath, ["--experimental-strip-types", "--experimental-loader", "./scripts/ts-loader.mjs", "src/cli.ts", "bootstrap"], { cwd: process.cwd(), env: { ...process.env, AGENT_HOME_STATE: root }, stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += String(chunk); });
    child.stdin.end(JSON.stringify({ format: "agent-home-bootstrap", version: 1, instanceId: "test", systemAdmins: [{ platform: "qq", userId: "admin-1" }], snowluma: { endpoint: "ws://snowluma:3001" } }));
    const exitCode = await new Promise<number>((resolve) => child.once("exit", (code) => resolve(code ?? 1)));
    assert.equal(exitCode, 0);
    const config = JSON.parse(await readFile(join(root, "config/bootstrap.json"), "utf8")) as { snowluma: { apiEndpoint: string }; systemAdmins: Array<{ userId: string }> };
    assert.equal(config.snowluma.apiEndpoint, "http://127.0.0.1:3000");
    assert.deepEqual(config.systemAdmins.map((admin) => admin.userId), ["admin-1"]);
    const db = new SqliteStore(join(root, "data/agent.db"));
    assert.equal(db.get<{ version: number }>("SELECT max(version) AS version FROM schema_migrations")?.version, 24);
    db.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bootstrap accepts a deployment without configured System Admin identities", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-home-bootstrap-no-owner-"));
  try {
    const child = spawn(process.execPath, ["--experimental-strip-types", "--experimental-loader", "./scripts/ts-loader.mjs", "src/cli.ts", "bootstrap"], { cwd: process.cwd(), env: { ...process.env, AGENT_HOME_STATE: root }, stdio: ["pipe", "pipe", "pipe"] });
    child.stdin.end(JSON.stringify({ format: "agent-home-bootstrap", version: 1, instanceId: "no-admin", snowluma: { endpoint: "ws://snowluma:3001" } }));
    const exitCode = await new Promise<number>((resolve) => child.once("exit", (code) => resolve(code ?? 1)));
    assert.equal(exitCode, 0);
    const config = JSON.parse(await readFile(join(root, "config/bootstrap.json"))) as { systemAdmins?: unknown };
    assert.equal("systemAdmins" in config, true);
    assert.deepEqual(config.systemAdmins, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bootstrap stores SnowLuma credentials in private state", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-home-bootstrap-secret-"));
  const credential = "access-token-not-for-stdout";
  try {
    let output = "";
    const child = spawn(process.execPath, ["--experimental-strip-types", "--experimental-loader", "./scripts/ts-loader.mjs", "src/cli.ts", "bootstrap"], { cwd: process.cwd(), env: { ...process.env, AGENT_HOME_STATE: root }, stdio: ["pipe", "pipe", "pipe"] });
    child.stdout.on("data", (chunk) => { output += String(chunk); });
    child.stdin.end(JSON.stringify({ format: "agent-home-bootstrap", version: 1, instanceId: "secret", owners: [], systemAdmins: [], snowluma: { endpoint: "ws://snowluma:3001", credential } }));
    const exitCode = await new Promise<number>((resolve) => child.once("exit", (code) => resolve(code ?? 1)));
    assert.equal(exitCode, 0);
    assert.equal(output.includes(credential), false);
    assert.equal(await readFile(join(root, "secrets/snowluma-access-token"), "utf8"), `${credential}\n`);
    assert.equal(await readFile(join(root, "secrets/snowluma-websocket-access-token"), "utf8"), `${credential}\n`);
    assert.equal((await stat(join(root, "secrets/snowluma-access-token"))).mode & 0o777, 0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bootstrap stores internal deployment secrets in private state", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-home-bootstrap-internal-secret-"));
  try {
    const child = spawn(process.execPath, ["--experimental-strip-types", "--experimental-loader", "./scripts/ts-loader.mjs", "src/cli.ts", "bootstrap"], { cwd: process.cwd(), env: { ...process.env, AGENT_HOME_STATE: root }, stdio: ["pipe", "pipe", "pipe"] });
    child.stdin.end(JSON.stringify({ format: "agent-home-bootstrap", version: 1, instanceId: "internal-secret", owners: [], systemAdmins: [], snowluma: { endpoint: "ws://snowluma:3001" }, internal: { controlToken: "control-secret", mcpToken: "mcp-secret", mcpControlToken: "mcp-control-secret", artifactTransferSecret: "artifact-secret" } }));
    const exitCode = await new Promise<number>((resolve) => child.once("exit", (code) => resolve(code ?? 1)));
    assert.equal(exitCode, 0);
    assert.equal(await readFile(join(root, "secrets/control-token"), "utf8"), "control-secret\n");
    assert.equal(await readFile(join(root, "secrets/mcp-main-token"), "utf8"), "mcp-secret\n");
    assert.equal(await readFile(join(root, "secrets/mcp-control-token"), "utf8"), "mcp-control-secret\n");
    assert.equal(await readFile(join(root, "secrets/artifact-transfer-secret"), "utf8"), "artifact-secret\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
