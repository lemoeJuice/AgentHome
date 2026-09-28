import test from "node:test";
import assert from "node:assert/strict";
import { createPiModelCommand, parsePiModels, type PiModelCommandRunner } from "../src/gateway/pi-model-command.ts";
import type { CommandContext } from "../src/gateway/registry.ts";
import type { AppConfig } from "../src/config.ts";
import type { Logger } from "../src/shared/logger.ts";

const logger = { child: () => logger, info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger;
const config = { instanceId: "test", runtime: { piCommand: "pi" } } as AppConfig;
const modelList = [
  "provider      model                   context  max-out  thinking  images",
  "openai-codex  gpt-5.6-luna           272K     128K     yes       yes",
  "anthropic     claude-sonnet-4-5      200K     64K      yes       yes",
].join("\n");

function context(args: string[], kind: "private" | "group" = "private"): CommandContext {
  return { invocationId: "cmd-test", requester: { platform: "qq", accountId: "default", userId: "owner" }, conversation: { conversationId: "conv", kind, platformConversationId: "user", threadId: null }, message: { messageId: "m1", replyTo: null }, args, rawArgs: args.join(" "), pluginState: { root: "", readJson: async () => null, writeJson: async () => undefined } };
}

test("Pi model command reads Pi's current settings and CLI model catalog", async () => {
  const calls: string[][] = [];
  const run: PiModelCommandRunner = async (args) => {
    calls.push(args);
    if (args.includes("--list-models")) return modelList;
    if (args.at(-1)?.includes("settings.json")) return JSON.stringify({ provider: "openai-codex", model: "gpt-5.6-luna" });
    return "";
  };
  const command = createPiModelCommand(config, logger, run);
  const status = await command(context([]));
  assert.match(status.text ?? "", /openai-codex\/gpt-5\.6-luna/);
  const list = await command(context(["list"]));
  assert.match(list.text ?? "", /anthropic\s+claude-sonnet-4-5/);
  assert.equal(calls.some((args) => args.includes("--list-models")), true);
  assert.equal(calls.filter((args) => args[0] === "exec").every((args) => args.includes("10002:10002") && args.includes("HOME=/state/model/home")), true);
});

test("Pi model command switches a model Pi reports and hot-switches sessions without Runtime restart", async () => {
  const calls: string[][] = [];
  const state = { provider: "openai-codex", model: "gpt-5.6-luna", thinkingLevel: "medium" };
  const run: PiModelCommandRunner = async (args) => {
    calls.push(args);
    if (args.includes("--list-models")) return modelList;
    if (args.includes("set-pi-thinking-level")) {
      state.thinkingLevel = args.at(-1)!;
      return JSON.stringify({ status: "ready", activeSessionsUpdated: 2, activeSessionFailures: 0 });
    }
    if (args.includes("set-pi-model")) {
      state.provider = "anthropic";
      state.model = "claude-sonnet-4-5";
      return `${JSON.stringify({ type: "hello_ack", status: "ready" })}\n${JSON.stringify({ status: "ready", activeSessionsUpdated: 2, activeSessionFailures: 0 })}`;
    }
    if (args.at(-1)?.includes("settings.json")) return JSON.stringify(state);
    return "";
  };
  const command = createPiModelCommand(config, logger, run);
  const variants = await command(context(["variant", "list"]));
  assert.match(variants.text ?? "", /off, minimal, low, medium, high, xhigh, max/);
  const rejected = await command(context(["set", "anthropic", "missing-model"]));
  assert.match(rejected.text ?? "", /没有/);
  assert.equal(calls.some((args) => args[0] === "restart"), false);

  const changed = await command(context(["set", "anthropic", "claude-sonnet-4-5"]));
  assert.match(changed.text ?? "", /已切换/);
  assert.deepEqual(state, { provider: "anthropic", model: "claude-sonnet-4-5", thinkingLevel: "medium" });
  assert.match(changed.text ?? "", /热切换 2 个活动 Pi 会话/);
  assert.equal(calls.some((args) => args[0] === "restart"), false);
  assert.equal(calls.some((args) => args.includes("set-pi-model")), true);

  const variant = await command(context(["variant", "high"]));
  assert.match(variant.text ?? "", /variant.*high/);
  assert.equal(state.thinkingLevel, "high");
  assert.equal(calls.some((args) => args.includes("set-pi-thinking-level")), true);
});

test("Pi model handler accepts group context after Gateway Owner authorization", async () => {
  let called = false;
  const command = createPiModelCommand(config, logger, async (args) => { called = true; return args.includes("--list-models") ? modelList : ""; });
  const result = await command(context(["list"], "group"));
  assert.equal(called, true);
  assert.match(result.text ?? "", /openai-codex\s+gpt-5.6-luna/);
});

test("Pi model table parser returns Pi-owned provider/model pairs", () => {
  assert.deepEqual(parsePiModels(modelList), [
    { provider: "openai-codex", model: "gpt-5.6-luna" },
    { provider: "anthropic", model: "claude-sonnet-4-5" },
  ]);
});
