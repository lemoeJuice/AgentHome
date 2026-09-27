import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AppConfig } from "../config.js";
import type { Logger } from "../shared/logger.js";
import type { CommandContext, CommandResult } from "./registry.js";

const execFileAsync = promisify(execFile);
const MAX_MODEL_LIST_CHARS = 3200;

type PiSelection = { provider: string | null; model: string | null };
export type PiModelCommandRunner = (args: string[], timeoutMs?: number) => Promise<string>;

export function createPiModelCommand(config: AppConfig, logger: Logger, runner?: PiModelCommandRunner) {
  const podman = process.env.PODMAN_COMMAND ?? "podman";
  const container = process.env.AGENT_HOME_CONTAINER ?? `agent-home-${config.instanceId}`;
  const pi = config.runtime.piCommand;
  const piAgentDir = config.runtime.piAgentDir;
  const log = logger.child("pi-model-command");

  async function defaultRunner(args: string[], timeout = 15_000): Promise<string> {
    const result = await execFileAsync(podman, args, { encoding: "utf8", timeout, maxBuffer: 2 * 1024 * 1024 });
    return result.stdout.trim();
  }
  const exec = runner ?? defaultRunner;

  async function readSelection(): Promise<PiSelection> {
    const output = await exec([
      "exec", "--user", "10002:10002", "--env", "HOME=/state/model/home", "--env", `PI_CODING_AGENT_DIR=${piAgentDir}`, container, "node", "--input-type=module", "-e",
      'import fs from "node:fs";const dir=process.env.PI_CODING_AGENT_DIR||"/state/model/pi/agent";try{const s=JSON.parse(fs.readFileSync(`${dir}/settings.json`,"utf8"));process.stdout.write(JSON.stringify({provider:s.defaultProvider||null,model:s.defaultModel||null}))}catch{process.stdout.write(JSON.stringify({provider:null,model:null}))}',
    ]);
    return JSON.parse(output) as PiSelection;
  }

  async function readPiModelList(search?: string): Promise<string> {
    return exec(["exec", "--user", "10002:10002", "--env", "HOME=/state/model/home", "--env", `PI_CODING_AGENT_DIR=${piAgentDir}`, container, pi, "--list-models", ...(search ? [search] : [])], 30_000);
  }

  async function setSelection(provider: string, model: string): Promise<{ activeSessionsUpdated?: number; activeSessionFailures?: number }> {
    const output = await exec(["exec", container, "agent-home", "control", "set-pi-model", provider, model], 30_000);
    const response = JSON.parse(output.split(/\r?\n/).at(-1) ?? "null") as { status?: string; activeSessionsUpdated?: number; activeSessionFailures?: number } | null;
    if (response?.status !== "ready") throw new Error("PI_MODEL_SWITCH_REJECTED");
    if ((response.activeSessionFailures ?? 0) > 0) log.warn("Some active Pi sessions could not switch models", { provider, model, ...response });
    return response;
  }

  return async (context: CommandContext): Promise<CommandResult> => {
    const [subcommand, providerArg, ...modelParts] = context.args;
    try {
      if (!subcommand || subcommand === "status") {
        const selection = await readSelection();
        return {
          text: selection.provider && selection.model
            ? `当前 Pi 模型：${selection.provider}/${selection.model}\n查看 Pi 可用模型：/model list [provider]\n切换模型：/model set <provider> <model>`
            : "Pi 尚未在 Pi 自身设置中选择默认 provider/model。请运行 scripts/pi-provider-onboarding.sh 完成首次选择。",
        };
      }

      if (subcommand === "list") {
        const output = await readPiModelList(providerArg);
        let text = output;
        if (text.length > MAX_MODEL_LIST_CHARS) text = `${text.slice(0, MAX_MODEL_LIST_CHARS)}\n…列表过长，已截断；可用 /model list <provider> 过滤。`;
        return { text: text || "Pi 没有返回可用模型列表。" };
      }

      if ((subcommand === "set" || subcommand === "use") && providerArg && modelParts.length) {
        const model = modelParts.join(" ");
        const output = await readPiModelList();
        if (!parsePiModels(output).some((entry) => entry.provider === providerArg && entry.model === model)) {
          return { text: `Pi 当前模型列表中没有 ${providerArg}/${model}。请用 /model list 查看 Pi 返回的可用 provider/model。` };
        }
        const result = await setSelection(providerArg, model);
        log.info("Pi model changed", { provider: providerArg, model, activeSessionsUpdated: result.activeSessionsUpdated, requesterId: context.requester.userId });
        const active = result.activeSessionsUpdated ? `已热切换 ${result.activeSessionsUpdated} 个活动 Pi 会话` : "当前没有活动 Pi 会话";
        const failed = result.activeSessionFailures ? `；${result.activeSessionFailures} 个活动会话未能切换（新会话仍使用该默认模型）` : "";
        return { text: `Pi 模型已切换为 ${providerArg}/${model}；${active}${failed}。Runtime 未重启。` };
      }

      return { text: "用法：/model；/model list [provider]；/model set <provider> <model>。" };
    } catch (error) {
      log.error("Pi model command failed", { error: String(error) });
      return { text: `读取或切换 Pi 模型失败：${String(error).slice(0, 300)}` };
    }
  };
}

export function parsePiModels(output: string): Array<{ provider: string; model: string }> {
  const models: Array<{ provider: string; model: string }> = [];
  for (const line of output.split(/\r?\n/)) {
    const columns = line.trim().split(/\s+/);
    const [provider, model, context] = columns;
    if (!provider || !model || !context || !/^\d+(?:\.\d+)?[KMG]$/i.test(context)) continue;
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(provider) || !/^[a-z0-9][a-z0-9._:/+-]*$/i.test(model)) continue;
    models.push({ provider, model });
  }
  return models;
}
