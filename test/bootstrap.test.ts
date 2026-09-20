import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "../src/db.js";

test("bootstrap initializes private state, schema, and secret without echoing it", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-home-bootstrap-"));
  const secret = "bootstrap-secret-value";
  try {
    const child = spawn(process.execPath, ["--experimental-strip-types", "--experimental-loader", "./scripts/ts-loader.mjs", "src/cli.ts", "bootstrap"], { cwd: process.cwd(), env: { ...process.env, AGENT_HOME_STATE: root }, stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += String(chunk); });
    child.stdin.end(JSON.stringify({ format: "agent-home-bootstrap", version: 1, instanceId: "test", owner: { platform: "qq", userId: "owner" }, snowluma: { endpoint: "ws://snowluma:3001", credential: secret } }));
    const exitCode = await new Promise<number>((resolve) => child.once("exit", (code) => resolve(code ?? 1)));
    assert.equal(exitCode, 0);
    assert.doesNotMatch(output, new RegExp(secret));
    const config = JSON.parse(await readFile(join(root, "config/bootstrap.json"), "utf8")) as { snowluma: { apiEndpoint: string } };
    assert.equal(config.snowluma.apiEndpoint, "http://127.0.0.1:3000");
    assert.equal(await readFile(join(root, "secrets/snowluma-access-token"), "utf8"), `${secret}\n`);
    assert.equal((await stat(join(root, "secrets/snowluma-access-token"))).mode & 0o777, 0o600);
    const db = new SqliteStore(join(root, "data/agent.db"));
    assert.equal(db.get<{ version: number }>("SELECT max(version) AS version FROM schema_migrations")?.version, 3);
    db.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
