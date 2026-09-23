import test from "node:test";
import assert from "node:assert/strict";
import { createConnection } from "node:net";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("supervisor starts Runtime after bootstrap and stops it cleanly", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-home-supervisor-"));
  const socketPath = join(root, "control.sock");
  const configPath = join(root, "agent-home.json");
  try {
    await mkdir(join(root, "config"), { recursive: true });
    await writeFile(join(root, "config", "bootstrap.json"), "{}\n");
    await writeFile(configPath, JSON.stringify({
      instanceId: "supervisor-test",
      owner: { platform: "qq", accountId: "default", userId: "owner" },
      paths: { gatewayState: join(root, "gateway.sqlite"), pluginData: join(root, "plugins"), backupDir: join(root, "backups"), stateRoot: root, runtimeSocket: socketPath },
      snowluma: { accountId: "default", endpoint: "ws://127.0.0.1:1", apiEndpoint: "http://127.0.0.1:1", reverseWebSocketPath: "/", reconnectMs: 10, requestTimeoutMs: 10 },
      chat: { global: { commandRequireMention: false, naturalLanguageMode: "explicit_wake" }, qq: { commandRequireMention: false, naturalLanguageMode: "explicit_wake" }, conversationOverrides: {} },
      runtime: { maxInFlight: 2, maxWorkers: 1, maxArtifactBytes: 1000, piCommand: "missing-pi", piTimeoutMs: 1000 },
      plugins: { enabled: [] },
      logging: { level: "error" },
    }));
    const child = spawn(process.execPath, ["--experimental-strip-types", "--experimental-loader", "./scripts/ts-loader.mjs", "src/cli.ts", "supervise"], { cwd: process.cwd(), env: { ...process.env, AGENT_HOME_CONFIG: configPath, AGENT_HOME_STATE: root, AGENT_HOME_SUPERVISOR_PID: join(root, "supervisor.pid") }, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.resume(); child.stderr.resume();
    for (let attempt = 0; attempt < 50; attempt++) {
      try { await access(socketPath); break; } catch { await new Promise((resolve) => setTimeout(resolve, 20)); }
      if (attempt === 49) throw new Error("SUPERVISOR_SOCKET_TIMEOUT");
    }
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection(socketPath);
      let buffer = "";
      const timer = setTimeout(() => { socket.destroy(); reject(new Error("SUPERVISOR_PING_TIMEOUT")); }, 2000);
      socket.setEncoding("utf8");
      socket.on("connect", () => socket.write('{"type":"hello","protocolVersion":1}\n'));
      socket.on("data", (chunk) => { buffer += String(chunk); if (buffer.includes('"type":"hello_ack"')) { clearTimeout(timer); socket.end(); resolve(); } });
      socket.on("error", (error) => { clearTimeout(timer); reject(error); });
    });
    child.kill("SIGTERM");
    const exitCode = await new Promise<number>((resolve) => child.once("exit", (code) => resolve(code ?? 1)));
    assert.equal(exitCode, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
