import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiCliHarness } from "../src/runtime/pi.ts";
import { Logger } from "../src/shared/logger.ts";

test("Worker Pi sandbox exposes only its workspace and session root", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-home-sandbox-"));
  const workspace = join(root, "projects", "allowed");
  const otherWorkspace = join(root, "projects", "other");
  const secret = join(root, "secrets", "token");
  const sessionRoot = join(root, "sessions");
  const command = join(workspace, "fake-pi.mjs");
  await mkdir(workspace, { recursive: true });
  await mkdir(otherWorkspace, { recursive: true });
  await mkdir(join(root, "secrets"), { recursive: true });
  await writeFile(join(otherWorkspace, "private.txt"), "other-task");
  await writeFile(secret, "secret");
  await writeFile(command, `#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
let buffer = "";
writeFileSync(process.argv[process.argv.length - 1], "session\\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf("\\n");
  while (index >= 0) {
    const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); index = buffer.indexOf("\\n");
    if (!line) continue;
    const input = JSON.parse(line);
    const response = (data = {}) => process.stdout.write(JSON.stringify({ type: "response", id: input.id, success: true, data }) + "\\n");
    if (input.type === "get_state") response({ sessionId: process.argv[process.argv.length - 1] });
    else if (input.type === "prompt") {
      const probe = JSON.parse(input.message);
      let canReadSecret = false; let canReadOther = false; let canWrite = true;
      try { readFileSync(probe.secret); canReadSecret = true; } catch {}
      try { readFileSync(probe.other); canReadOther = true; } catch {}
      try { writeFileSync(probe.target, "worker-write"); } catch { canWrite = false; }
      response();
       process.stdout.write(JSON.stringify({ type: "turn_end", messages: [{ role: "assistant", content: [{ type: "text", text: JSON.stringify({ canReadSecret, canReadOther, canWrite, sessionVisible: existsSync(probe.session) }) }] }] }) + "\\n");
       process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
    } else response();
  }
});
`);
  await chmod(command, 0o755);
  const harness = new PiCliHarness(command, new Logger("test", "error"), "bwrap");
  try {
    const writableSession = await harness.createSession(join(sessionRoot, "write.jsonl"), { cwd: workspace, sandbox: { workspaceRoot: workspace, sessionRoot, writeAccess: true } });
    const writable = JSON.parse(await harness.send(writableSession, JSON.stringify({ secret, other: join(otherWorkspace, "private.txt"), target: join(workspace, "write.txt"), session: join(sessionRoot, "write.jsonl") })));
    assert.deepEqual(writable, { canReadSecret: false, canReadOther: false, canWrite: true, sessionVisible: true });
    const readonlySession = await harness.createSession(join(sessionRoot, "read.jsonl"), { cwd: workspace, sandbox: { workspaceRoot: workspace, sessionRoot, writeAccess: false } });
    const readonly = JSON.parse(await harness.send(readonlySession, JSON.stringify({ secret, other: join(otherWorkspace, "private.txt"), target: join(workspace, "readonly.txt"), session: join(sessionRoot, "read.jsonl") })));
    assert.deepEqual(readonly, { canReadSecret: false, canReadOther: false, canWrite: false, sessionVisible: true });
  } finally {
    await harness.stop();
    await rm(root, { recursive: true, force: true });
  }
});
