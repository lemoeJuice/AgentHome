import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { PiCliHarness } from "../src/runtime/pi.ts";
import { Logger } from "../src/shared/logger.ts";

test("PiCliHarness drives a persistent RPC session", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-home-pi-"));
  const command = join(root, "fake-pi.mjs");
  const sessionPath = join(root, "session.jsonl");
  await writeFile(command, `#!/usr/bin/env node
    import { appendFileSync, writeFileSync } from "node:fs";
     writeFileSync(process.argv[process.argv.length - 1], JSON.stringify({ booted: true, args: process.argv.slice(2) }) + "\\n");
    let buffer = "";
    let transientAttempts = 0;
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      buffer += chunk;
      let index = buffer.indexOf("\\n");
      while (index >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); index = buffer.indexOf("\\n");
        if (!line) continue;
        const command = JSON.parse(line);
        const response = (data = {}) => process.stdout.write(JSON.stringify({ type: "response", id: command.id, success: true, data }) + "\\n");
         if (command.type === "get_state") response({ sessionId: process.argv[process.argv.length - 1].endsWith("main.jsonl") ? "pi-main" : "pi-session-real" });
          else if (command.type === "prompt" || command.type === "steer") {
            response();
            if (command.message === "timeout") return;
            if (command.message === "exit") { setTimeout(() => process.exit(2), 20); return; }
            if (command.message === "transient" && transientAttempts++ === 0) {
              process.stdout.write(JSON.stringify({ type: "agent_end", messages: [{ role: "assistant", content: [], stopReason: "error", errorMessage: "provider_transport_failure: fetch failed" }] }) + "\\n");
              process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
              return;
            }
            if (command.message === "empty") {
              process.stdout.write(JSON.stringify({ type: "turn_end", message: { role: "assistant", content: [], stopReason: "stop" } }) + "\\n");
              process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
              return;
            }
           if (command.type === "steer" && command.message === "queued") return;
           if (command.type === "prompt" && command.message === "long") {
             setTimeout(() => process.stdout.write(JSON.stringify({ type: "turn_end", message: { role: "assistant", content: [{ type: "text", text: "long-result" }] } }) + "\\n"), 150);
             setTimeout(() => process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n"), 160);
             return;
           }
           if (command.message === "settled-event") {
             process.stdout.write(JSON.stringify({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "early" }] }] }) + "\\n");
             setTimeout(() => process.stdout.write(JSON.stringify({ type: "turn_end", message: { role: "assistant", content: [{ type: "text", text: "settled" }] } }) + "\\n"), 10);
             setTimeout(() => process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n"), 20);
             return;
           }
           process.stdout.write(JSON.stringify({ type: "message_end", messages: [{ role: "assistant", content: [{ type: "text", text: "partial" }] }] }) + "\\n");
           process.stdout.write(JSON.stringify({ type: "turn_end", messages: [{ role: "assistant", content: [{ type: "text", text: "reply:" + command.message }] }] }) + "\\n");
           process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
        } else response();
      }
    });
  `);
  await chmod(command, 0o755);
  const harness = new PiCliHarness(command, new Logger("test", "error"), undefined, undefined, { agentDir: root });
  const boundaryHarness = new PiCliHarness(command, new Logger("test", "error"), undefined, undefined, { agentDir: root });
  try {
    const session = await harness.createSession(sessionPath);
    assert.equal(session.sessionId, "pi-session-real");
    assert.equal(await harness.resumeSession(session), true);
    assert.equal(await harness.send(session, "hello"), "reply:hello");
    assert.equal(await harness.send(session, "transient"), "reply:transient");
    await assert.rejects(harness.send(session, "empty"), /PI_EMPTY_RESPONSE/);
    assert.equal(await harness.steer(session, "follow up"), "reply:follow up");
    const long = harness.send(session, "long");
    await new Promise((resolve) => setTimeout(resolve, 30));
    const queued = harness.steer(session, "queued");
    assert.deepEqual(await Promise.all([long, queued]), ["long-result", "long-result"]);
    assert.equal(await harness.send(session, "settled-event"), "settled");
    assert.equal(await harness.inspect(session), "available");
    assert.equal(typeof harness.processId(session), "number");
    assert.equal(await harness.abort(session), true);
    assert.equal(harness.processId(session), undefined);
    const mainSessionPath = join(root, "main.jsonl");
    const mainSession = await harness.createSession(mainSessionPath, { mainTools: true, extensionPath: join(root, "pi-tools.js") });
    assert.equal(mainSession.sessionId, "pi-main");
    const mainInvocation = JSON.parse(await readFile(mainSessionPath, "utf8")) as { args: string[] };
    assert.ok(mainInvocation.args.includes("--no-builtin-tools"));
    assert.ok(mainInvocation.args.includes("--no-extensions"));
    assert.ok(mainInvocation.args.includes("--no-context-files"));
    assert.ok(mainInvocation.args.includes(join(root, "pi-tools.js")));
    assert.equal(mainInvocation.args.includes("--provider"), false);
    assert.equal(mainInvocation.args.includes("--model"), false);
    const switched = await harness.setDefaultModel("openai-codex", "gpt-5.6-luna");
    assert.equal(switched.activeSessionsUpdated, 1);
    const settings = JSON.parse(await readFile(join(root, "settings.json"), "utf8")) as { defaultProvider: string; defaultModel: string };
    assert.deepEqual(settings, { defaultProvider: "openai-codex", defaultModel: "gpt-5.6-luna" });
    const restricted = await boundaryHarness.createSession(join(root, "restricted.jsonl"), { mainTools: true });
    assert.equal(restricted.sessionId, "pi-session-real");
    const restrictedInvocation = JSON.parse(await readFile(join(root, "restricted.jsonl"), "utf8")) as { args: string[] };
    assert.ok(restrictedInvocation.args.includes("--no-builtin-tools"));
    assert.ok(restrictedInvocation.args.includes("--no-extensions"));
    assert.ok(restrictedInvocation.args.includes("--no-skills"));
    assert.ok(restrictedInvocation.args.includes("--no-context-files"));
    assert.equal(restrictedInvocation.args.includes("--extension"), false);
    const missing = { sessionId: "missing", sessionPath: join(root, "missing.jsonl") };
    assert.equal(await harness.inspect(missing), "missing");
    assert.equal(await harness.resumeSession(missing), false);
    await assert.rejects(harness.send(session, "timeout", { timeoutMs: 20 }), /PI_TIMEOUT/);
    await new Promise((resolve) => setTimeout(resolve, 150));
    await assert.rejects(harness.send(session, "exit", { timeoutMs: 1000 }), /PI_EXIT/);
  } finally {
    await harness.stop();
    await boundaryHarness.stop();
    await rm(root, { recursive: true, force: true });
  }
});
