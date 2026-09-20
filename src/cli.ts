import { mkdir, access, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { loadConfig } from "./config.js";
import { Logger, rootLogger } from "./shared/logger.js";
import { GatewayApp } from "./gateway/app.js";
import { GatewayState } from "./gateway/state.js";
import { CommandRegistry, AgentActionRegistry } from "./gateway/registry.js";
import { loadPlugins } from "./gateway/plugins.js";
import { PodmanController } from "./controller.js";
import { RuntimeApp } from "./runtime/runtime.js";
import { runControlPing, runControlStream } from "./runtime/control.js";
import { bootstrapFromStdin } from "./runtime/bootstrap.js";
import { secretFromConfig } from "./config.js";

async function main(): Promise<void> {
  const command = process.argv[2] ?? "help";
  if (command === "bootstrap") { await bootstrapFromStdin(process.env.AGENT_HOME_STATE ?? "/state"); return; }
  if (command === "hold") { await holdProcess(); return; }
  if (command === "help") { process.stdout.write("agent-home gateway|runtime|control stream|control ping|bootstrap|doctor|status\n"); return; }
  let config: Awaited<ReturnType<typeof loadConfig>>;
  try { config = await loadConfig(); } catch (error) {
    if (command === "doctor") { await doctorUnavailable(String(error)); return; }
    throw error;
  }
  const logger = rootLogger(config.logging.level);
  if (command === "runtime") { const runtime = new RuntimeApp(config, logger); await runtime.start(); await waitForSignal(() => runtime.stop()); return; }
  if (command === "control") {
    const subcommand = process.argv[3] ?? "stream";
    if (subcommand === "stream") await runControlStream(config.paths.runtimeSocket);
    else if (subcommand === "ping") await runControlPing(config.paths.runtimeSocket);
    else throw new Error(`UNKNOWN_CONTROL_COMMAND:${subcommand}`);
    return;
  }
  if (command === "gateway" || command === "start") { const gateway = new GatewayApp(config, logger); await gateway.start(); await waitForSignal(() => gateway.stop()); return; }
  if (command === "doctor") { await doctor(config, logger); return; }
  if (command === "status") { process.stdout.write(JSON.stringify({ config: config.instanceId, container: process.env.AGENT_HOME_CONTAINER ?? `agent-home-${config.instanceId}`, gatewayState: config.paths.gatewayState }) + "\n"); return; }
  throw new Error(`UNKNOWN_COMMAND:${command}`);
}

async function doctorUnavailable(configurationError: string): Promise<void> {
  const checks: Record<string, { status: string; detail?: string }> = { config: { status: "missing_configuration", detail: configurationError } };
  try { const { execFileSync } = await import("node:child_process"); checks.podman = { status: "healthy", detail: execFileSync(process.env.PODMAN_COMMAND ?? "podman", ["--version"], { encoding: "utf8" }).trim() }; } catch (error) { checks.podman = { status: "missing_dependency", detail: String(error) }; }
  try { const { execFileSync } = await import("node:child_process"); checks.pi = { status: "healthy", detail: execFileSync(process.env.PI_COMMAND ?? "pi", ["--version"], { encoding: "utf8" }).trim() }; } catch (error) { checks.pi = { status: "missing_dependency", detail: String(error) }; }
  process.stdout.write(`${JSON.stringify(checks, null, 2)}\n`);
  process.exitCode = 1;
}

async function doctor(config: Awaited<ReturnType<typeof loadConfig>>, logger: Logger): Promise<void> {
  const checks: Record<string, { status: string; detail?: string }> = {};
  checks.config = { status: "healthy" };
  try {
    await access(dirname(config.paths.gatewayState));
    const gatewayState = new GatewayState(config.paths.gatewayState);
    checks.gatewayState = { status: "healthy", detail: `schema ${String(gatewayState.store.get<{ version: number }>("SELECT max(version) AS version FROM schema_migrations")?.version ?? 0)}` };
    const commands = new CommandRegistry(); const actions = new AgentActionRegistry();
    await loadPlugins(config, commands, actions, logger);
    checks.plugins = { status: "healthy", detail: `${commands.list().length} commands, ${actions.list().length} actions` };
    const controller = new PodmanController(config, gatewayState, logger);
    const status = await controller.status();
    checks.container = { status: status.container ? "healthy" : "temporarily_unavailable", detail: `stream=${status.stream}` };
    gatewayState.close();
  } catch (error) { checks.gatewayState = { status: "internal_failure", detail: String(error) }; }
  try { const runtime = new RuntimeApp(config, logger); checks.runtime = { status: "healthy" }; await runtime.stop(); } catch (error) { checks.runtime = { status: "internal_failure", detail: String(error) }; }
  try { const { execFileSync } = await import("node:child_process"); checks.podman = { status: "healthy", detail: execFileSync(process.env.PODMAN_COMMAND ?? "podman", ["--version"], { encoding: "utf8" }).trim() }; } catch (error) { checks.podman = { status: "missing_dependency", detail: String(error) }; }
  try { const { execFileSync } = await import("node:child_process"); checks.pi = { status: "healthy", detail: execFileSync(config.runtime.piCommand, ["--version"], { encoding: "utf8" }).trim() }; } catch (error) { checks.pi = { status: "missing_dependency", detail: String(error) }; }
  checks.snowluma = { status: secretFromConfig(config) ? "configured" : "missing_configuration", detail: config.snowluma.apiEndpoint };
  process.stdout.write(`${JSON.stringify(checks, null, 2)}\n`);
  if (Object.values(checks).some((check) => check.status === "missing_configuration" || check.status === "missing_dependency" || check.status === "internal_failure")) process.exitCode = 1;
}

async function loadConfigForState(): Promise<Awaited<ReturnType<typeof loadConfig>>> {
  try { return await loadConfig(); } catch (error) {
    const stateRoot = process.env.AGENT_HOME_STATE ?? "/state";
    const bootstrap = resolve(stateRoot, "config/bootstrap.json");
    try {
      const value = JSON.parse(await readFile(bootstrap, "utf8")) as Partial<Awaited<ReturnType<typeof loadConfig>>>;
      await mkdir(dirname(bootstrap), { recursive: true });
      return { ...(value as Awaited<ReturnType<typeof loadConfig>>), paths: { gatewayState: "./runtime-state/gateway.sqlite", pluginData: "./runtime-state/plugin-data", backupDir: "./backups", stateRoot, runtimeSocket: "/run/agent-home/control.sock" }, snowluma: { ...(value.snowluma as Awaited<ReturnType<typeof loadConfig>>["snowluma"]), accountId: "default", accessTokenEnv: "SNOWLUMA_ACCESS_TOKEN", reverseWebSocketPath: "/onebot/v11/ws", reconnectMs: 2000, requestTimeoutMs: 15000 }, chat: { global: { commandRequireMention: false, naturalLanguageMode: "explicit_wake" }, qq: { commandRequireMention: false, naturalLanguageMode: "explicit_wake" }, conversationOverrides: {} }, runtime: { maxInFlight: 16, maxWorkers: 2, maxArtifactBytes: 52428800, piCommand: process.env.PI_COMMAND ?? "pi", piTimeoutMs: 3600000 }, plugins: { enabled: [] }, logging: { level: "info" } };
    } catch { throw error; }
  }
}

async function waitForSignal(stop: () => Promise<void>): Promise<void> {
  await new Promise<void>((resolve) => {
    let stopping = false;
    const handler = () => { if (stopping) return; stopping = true; void stop().finally(resolve); };
    process.once("SIGINT", handler); process.once("SIGTERM", handler);
  });
}

async function holdProcess(): Promise<void> {
  await new Promise<void>((resolve) => {
    const stop = () => { process.off("SIGINT", stop); process.off("SIGTERM", stop); resolve(); };
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
  });
}

main().catch((error) => { process.stderr.write(`${String(error)}\n`); process.exitCode = 1; });
