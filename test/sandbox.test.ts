import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PiCliHarness } from "../src/runtime/pi.ts";
import { Logger } from "../src/shared/logger.ts";

test("Trusted Pi sandbox mounts Model Plane state but never a Principal workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-home-model-plane-"));
  const workspace = join(root, "principals", "owner", "projects", "default");
  const sessionRoot = join(root, "model", "sessions");
  const agentDir = join(root, "model", "pi", "agent");
  const toolSocket = join(root, "run", "tools.sock");
  const argsPath = join(root, "bwrap-args.json");
  const fakePi = join(root, "fake-pi.cjs");
  const fakeBwrap = join(root, "fake-bwrap.sh");
  const fakeBwrapProgram = join(root, "fake-bwrap.mjs");
  await mkdir(workspace, { recursive: true });
  await mkdir(sessionRoot, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await mkdir(join(root, "run"), { recursive: true });
  await writeFile(fakePi, `#!/usr/bin/env node
let buffer = "";
const session = process.argv[process.argv.length - 1];
require("node:fs").writeFileSync(session, "session\\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { buffer += chunk; let index = buffer.indexOf("\\n"); while (index >= 0) { const input = JSON.parse(buffer.slice(0,index)); buffer = buffer.slice(index+1); index = buffer.indexOf("\\n"); const data = input.type === "get_state" ? { sessionId: "model-session" } : {}; process.stdout.write(JSON.stringify({ type:"response",id:input.id,success:true,data })+"\\n"); if (input.type === "prompt") { process.stdout.write(JSON.stringify({ type:"turn_end",message:{role:"assistant",content:[{type:"text",text:"ok"}]}})+"\\n");process.stdout.write(JSON.stringify({type:"agent_settled"})+"\\n"); } } });
`);
  await writeFile(fakeBwrapProgram, `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(args));
const marker = args.indexOf("--");
if (marker < 0) process.exit(2);
const child = spawn(process.execPath, [args[marker+1], ...args.slice(marker+2)], { stdio: "inherit", env: process.env });
child.on("exit", (code) => process.exit(code ?? 1));
`);
  await writeFile(fakeBwrap, `#!/bin/sh
exec ${process.execPath} ${JSON.stringify(fakeBwrapProgram)} "$@"
`);
  await chmod(fakePi, 0o755);
  await chmod(fakeBwrap, 0o755);
  const harness = new PiCliHarness(fakePi, new Logger("test", "error"), fakeBwrap, undefined, { agentDir });
  try {
    process.env.SANDBOX_ARGS_LOG = argsPath;
    const session = await harness.createSession(join(sessionRoot, "session.jsonl"), {
      cwd: workspace,
      mainTools: true,
      sandbox: { sessionRoot, toolSocket, toolToken: "worker-token" },
      extensionPath: fileURLToPath(new URL("../src/runtime/worker-tools.ts", import.meta.url)),
    });
    assert.equal(session.sessionId, "model-session");
    await harness.send(session, "safe");
    const args = JSON.parse(await readFile(argsPath, "utf8")) as string[];
    assert.ok(args.includes("--no-builtin-tools"));
    assert.ok(args.includes("--no-extensions"));
    assert.ok(args.includes("--no-skills"));
    assert.ok(args.includes("--no-context-files"));
    assert.ok(args.includes(agentDir));
    assert.ok(args.includes(sessionRoot));
    assert.ok(args.includes(toolSocket));
    assert.equal(args.some((item) => item.includes("AGENT_HOME_MCP_URL") || item.includes("AGENT_HOME_MCP_TOKEN")), false);
    assert.equal(args.some((item) => item.includes(workspace)), false);
    const bindings = args.flatMap((item, index) => ["--bind", "--ro-bind"].includes(item) ? args.slice(index + 1, index + 3) : []);
    assert.equal(bindings.includes(workspace), false);
    await assert.rejects(
      harness.createSession(join(sessionRoot, "untrusted.jsonl"), { sandbox: { sessionRoot }, mainTools: true, extensionPath: join(workspace, ".pi", "extensions", "malicious.js") }),
      /PI_UNTRUSTED_EXTENSION_PATH/,
    );
  } finally {
    delete process.env.SANDBOX_ARGS_LOG;
    await harness.stop();
    await rm(root, { recursive: true, force: true });
  }
});
