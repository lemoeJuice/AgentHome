import { access, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { loadConfig, snowlumaAccessToken, snowlumaWebSocketAccessToken } from "./config.js";
import { Logger, rootLogger } from "./shared/logger.js";
import { GatewayApp } from "./gateway/app.js";
import { GatewayState } from "./gateway/state.js";
import { CommandRegistry, AgentActionRegistry } from "./gateway/registry.js";
import { loadPlugins } from "./gateway/plugins.js";
import { PodmanController } from "./controller.js";
import { RuntimeApp } from "./runtime/runtime.js";
import { runControlPing, runControlRequest, runControlStream } from "./runtime/control.js";
import { bootstrapFromStdin } from "./runtime/bootstrap.js";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { resolveWebSocketEndpoint } from "./qq/onebot.js";
import { createProxyRelay } from "./proxy-relay.js";

async function main(): Promise<void> {
  const command = process.argv[2] ?? "help";
  if (command === "bootstrap") { await bootstrapFromStdin(process.env.AGENT_HOME_STATE ?? "/state"); return; }
  if (command === "hold") { await holdProcess(); return; }
  if (command === "supervise") { await superviseRuntime(); return; }
  if (command === "proxy-relay") {
    const server = createProxyRelay({ listenPort: Number(process.env.AGENT_HOME_PROXY_RELAY_LISTEN_PORT ?? process.env.AGENT_HOME_PROXY_RELAY_PORT ?? 17890), upstreamHost: process.env.AGENT_HOME_PROXY_RELAY_UPSTREAM_HOST ?? "127.0.0.1", upstreamPort: Number(process.env.AGENT_HOME_PROXY_RELAY_UPSTREAM_PORT ?? process.env.AGENT_HOME_PROXY_UPSTREAM_PORT ?? 7897) });
    await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
    await waitForSignal(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
    return;
  }
  if (command === "help") { process.stdout.write("agent-home gateway|runtime|control stream|control ping|control backup-prepare|control backup-finish|control set-pi-model <provider> <model>|control set-pi-thinking-level <level>|bootstrap|doctor|status\n"); return; }
  let config: Awaited<ReturnType<typeof loadConfig>>;
  try { config = await loadConfig(); } catch (error) {
    if (command === "doctor" || command === "status") { await doctorUnavailable(String(error)); return; }
    throw error;
  }
  const logger = rootLogger(config.logging.level);
  if (command === "runtime") { const runtime = new RuntimeApp(config, logger); await runtime.start(); await waitForSignal(() => runtime.stop()); return; }
  if (command === "control") {
    const subcommand = process.argv[3] ?? "stream";
    if (subcommand === "stream") await runControlStream(config.paths.runtimeSocket);
    else if (subcommand === "ping") await runControlPing(config.paths.runtimeSocket);
    else if (subcommand === "backup-prepare") await runControlRequest(config.paths.runtimeSocket, { type: "backup_prepare" });
    else if (subcommand === "backup-finish") await runControlRequest(config.paths.runtimeSocket, { type: "backup_finish" });
    else if (subcommand === "set-pi-model") {
      const provider = process.argv[4]; const model = process.argv[5];
      if (!provider || !model) throw new Error("USAGE: agent-home control set-pi-model <provider> <model>");
      await runControlRequest(config.paths.runtimeSocket, { type: "set_pi_model", provider, model });
    }
    else if (subcommand === "set-pi-thinking-level") {
      const level = process.argv[4];
      if (!level) throw new Error("USAGE: agent-home control set-pi-thinking-level <level>");
      await runControlRequest(config.paths.runtimeSocket, { type: "set_pi_thinking_level", level });
    }
    else throw new Error(`UNKNOWN_CONTROL_COMMAND:${subcommand}`);
    return;
  }
  if (command === "gateway" || command === "start") { const gateway = new GatewayApp(config, logger); await gateway.start(); await waitForSignal(() => gateway.stop()); return; }
  if (command === "doctor") { await doctor(config, logger); return; }
  if (command === "status") { await doctor(config, logger, false); return; }
  throw new Error(`UNKNOWN_COMMAND:${command}`);
}

async function doctorUnavailable(configurationError: string): Promise<void> {
  const checks: Record<string, { status: string; detail?: string }> = { config: { status: "missing_configuration", detail: configurationError } };
  try { const { execFileSync } = await import("node:child_process"); checks.podman = { status: "healthy", detail: execFileSync(process.env.PODMAN_COMMAND ?? "podman", ["--version"], { encoding: "utf8" }).trim() }; } catch (error) { checks.podman = { status: "missing_dependency", detail: String(error) }; }
  try { const { execFileSync } = await import("node:child_process"); checks.pi = { status: "healthy", detail: execFileSync(process.env.PI_COMMAND ?? "pi", ["--version"], { encoding: "utf8" }).trim() }; } catch (error) { checks.pi = { status: "missing_dependency", detail: String(error) }; }
  process.stdout.write(`${JSON.stringify(checks, null, 2)}\n`);
  process.exitCode = 1;
}

async function doctor(config: Awaited<ReturnType<typeof loadConfig>>, logger: Logger, failOnDegraded = true): Promise<void> {
  const checks: Record<string, { status: string; detail?: string }> = {};
  let containerRunning = false;
  checks.config = { status: "healthy" };
  try {
    await access(dirname(config.paths.gatewayState));
    const gatewayState = new GatewayState(config.paths.gatewayState);
    checks.gatewayState = { status: "healthy", detail: `schema ${String(gatewayState.store.get<{ version: number }>("SELECT max(version) AS version FROM schema_migrations")?.version ?? 0)}` };
    const commands = new CommandRegistry(); const actions = new AgentActionRegistry();
    await loadPlugins(config, commands, actions, logger);
    checks.plugins = { status: "healthy", detail: `${commands.list().length} commands, ${actions.list().length} actions` };
    const controller = new PodmanController(config, gatewayState, logger);
    const status = await controller.health();
    containerRunning = status.container;
    checks.container = { status: status.container ? "healthy" : "temporarily_unavailable", detail: `stream=${status.stream}` };
    checks.supervisor = { status: status.supervisor ? "healthy" : "temporarily_unavailable" };
    checks.runtime = { status: status.runtime ? "healthy" : "temporarily_unavailable", detail: "authenticated control ping" };
    checks.main = { status: status.runtime ? "healthy" : "temporarily_unavailable", detail: "Main uses the authenticated Runtime control and Pi boundary" };
    gatewayState.close();
  } catch (error) { checks.gatewayState = { status: "internal_failure", detail: String(error) }; }
  let podmanAvailable = false;
  try { const { execFileSync } = await import("node:child_process"); checks.podman = { status: "healthy", detail: execFileSync(process.env.PODMAN_COMMAND ?? "podman", ["--version"], { encoding: "utf8" }).trim() }; podmanAvailable = true; } catch (error) { checks.podman = { status: "missing_dependency", detail: String(error) }; }
  try {
    const { execFileSync } = await import("node:child_process");
    const container = process.env.AGENT_HOME_CONTAINER ?? `agent-home-${config.instanceId}`;
    if (podmanAvailable) checks.pi = { status: "healthy", detail: execFileSync(process.env.PODMAN_COMMAND ?? "podman", ["exec", container, config.runtime.piCommand, "--version"], { encoding: "utf8", timeout: 5000 }).trim() };
    else checks.pi = { status: "temporarily_unavailable", detail: "Pi is expected inside the Agent Home container" };
  } catch (error) { checks.pi = { status: "temporarily_unavailable", detail: String(error) }; }
  if (podmanAvailable && containerRunning) {
    try {
      const { execFileSync } = await import("node:child_process");
      const container = process.env.AGENT_HOME_CONTAINER ?? `agent-home-${config.instanceId}`;
      const record = JSON.parse(execFileSync(process.env.PODMAN_COMMAND ?? "podman", ["exec", container, "cat", "/state/config/pi-install.json"], { encoding: "utf8", timeout: 5000 })) as { package?: string; version?: string; command?: string; prefix?: string };
      const actualVersion = execFileSync(process.env.PODMAN_COMMAND ?? "podman", ["exec", container, config.runtime.piCommand, "--version"], { encoding: "utf8", timeout: 5000 }).trim();
      const valid = Boolean(record.package && record.version && record.version === actualVersion && record.command === config.runtime.piCommand && record.prefix);
      checks.piInstallation = valid ? { status: "healthy", detail: `${record.package}@${record.version}; provider setup skipped` } : { status: "degraded", detail: "Pi installation record does not match the executable" };
    } catch (error) { checks.piInstallation = { status: "temporarily_unavailable", detail: String(error) }; }
  } else {
    checks.piInstallation = { status: "temporarily_unavailable", detail: "Agent Home container is not running" };
  }
  checks.snowluma = await checkSnowLuma(config);
  process.stdout.write(`${JSON.stringify(checks, null, 2)}\n`);
  if (failOnDegraded && Object.values(checks).some((check) => check.status !== "healthy" && check.status !== "configured")) process.exitCode = 1;
}

async function checkSnowLuma(config: Awaited<ReturnType<typeof loadConfig>>): Promise<{ status: string; detail?: string }> {
  const accessToken = snowlumaAccessToken(config);
  const headers = { "content-type": "application/json", ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}) };
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(config.snowluma.requestTimeoutMs, 5000));
    let response: Response;
    try { response = await fetch(new URL("get_login_info", `${config.snowluma.apiEndpoint.replace(/\/$/, "")}/`).toString(), { method: "POST", headers, body: "{}", signal: controller.signal }); }
    finally { clearTimeout(timer); }
    if (!response.ok) return { status: "temporarily_unavailable", detail: `SnowLuma API HTTP ${response.status}` };
    const body = await response.json() as { status?: unknown; retcode?: unknown };
    if (body.status !== "ok" || body.retcode !== 0) return { status: "degraded", detail: "SnowLuma API returned a failed OneBot envelope" };
    await checkSnowLumaWebSocket(config);
    return { status: "healthy", detail: config.snowluma.apiEndpoint };
  } catch (error) {
    return { status: "temporarily_unavailable", detail: String(error) };
  }
}

async function checkSnowLumaWebSocket(config: Awaited<ReturnType<typeof loadConfig>>): Promise<void> {
   const url = new URL(resolveWebSocketEndpoint(config.snowluma.endpoint, config.snowluma.reverseWebSocketPath));
   const accessToken = snowlumaWebSocketAccessToken(config);
   if (accessToken) url.searchParams.set("access_token", accessToken);
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => { socket.close(); reject(new Error("SNOWLUMA_WS_TIMEOUT")); }, Math.min(config.snowluma.requestTimeoutMs, 5000));
    socket.addEventListener("open", () => { clearTimeout(timer); socket.close(); resolve(); }, { once: true });
    socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("SNOWLUMA_WS_UNAVAILABLE")); }, { once: true });
  });
}

async function loadConfigForState(): Promise<Awaited<ReturnType<typeof loadConfig>>> {
  try { return await loadConfig(); } catch (error) {
    const stateRoot = process.env.AGENT_HOME_STATE ?? "/state";
    const bootstrap = resolve(stateRoot, "config/bootstrap.json");
    try {
      const value = JSON.parse(await readFile(bootstrap, "utf8")) as Partial<Awaited<ReturnType<typeof loadConfig>>>;
      await mkdir(dirname(bootstrap), { recursive: true });
        return { ...(value as Awaited<ReturnType<typeof loadConfig>>), paths: { gatewayState: "./.agent-home/runtime-state/gateway.sqlite", pluginData: "./.agent-home/runtime-state/plugin-data", backupDir: "./backups", stateRoot, runtimeSocket: "/run/agent-home/control.sock" }, snowluma: { ...(value.snowluma as Awaited<ReturnType<typeof loadConfig>>["snowluma"]), accountId: "default", reverseWebSocketPath: (value.snowluma as Awaited<ReturnType<typeof loadConfig>>["snowluma"]).reverseWebSocketPath ?? "/onebot/v11/ws", reconnectMs: 2000, requestTimeoutMs: 15000 }, chat: { global: { commandRequireMention: false, naturalLanguageMode: "explicit_wake" }, qq: { commandRequireMention: false, naturalLanguageMode: "explicit_wake" }, conversationOverrides: {} }, agent: { persona: typeof value.agent?.persona === "string" ? value.agent.persona : "" }, runtime: { maxInFlight: 16, maxWorkers: 2, maxWorkersTotal: 8, maxWorkersPerProject: 2, maxWorkersPerRequester: 4, maxTasks: 32, maxTasksPerRequester: 8, maxTasksPerPrincipal: 8, maxArtifactBytes: 52428800, piCommand: process.env.PI_COMMAND ?? "pi", piTimeoutMs: 3600000, workerSandboxCommand: process.env.AGENT_HOME_WORKER_SANDBOX ?? "bwrap", piAgentDir: `${stateRoot}/model/pi/agent` }, principalExecution: { maxWorkersPerPrincipal: 1, taskTimeoutMs: 1800000, commandTimeoutMs: 600000, cpuSeconds: 600, memoryBytes: 17179869184, pids: 128, maxFileBytes: 536870912, workspaceQuotaBytes: 2147483648, cacheQuotaBytes: 1073741824, artifactQuotaBytes: 536870912 }, plugins: { enabled: [] }, logging: { level: "info" } };
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

async function superviseRuntime(): Promise<void> {
  const stateRoot = process.env.AGENT_HOME_STATE ?? "/state";
  const pidPath = process.env.AGENT_HOME_SUPERVISOR_PID ?? "/run/agent-home/supervisor.pid";
  await mkdir(dirname(pidPath), { recursive: true });
  await writeFile(pidPath, `${process.pid}\n`, { mode: 0o600 });
  let child: ReturnType<typeof spawn> | undefined;
  let stopping = false;
  const stop = () => {
    stopping = true;
    if (child && !child.killed) child.kill("SIGTERM");
  };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  try {
    while (!stopping) {
      try { await access(join(stateRoot, "config", "bootstrap.json")); } catch { await delay(1000); continue; }
      child = spawn(process.execPath, [...process.execArgv, process.argv[1]!, "runtime"], { stdio: "inherit", env: process.env });
      await new Promise<void>((resolve) => child?.once("exit", () => resolve()));
      child = undefined;
      if (!stopping) await delay(1000);
    }
  } finally {
    process.off("SIGINT", stop); process.off("SIGTERM", stop);
    await unlink(pidPath).catch(() => undefined);
  }
}

main().catch((error) => { process.stderr.write(`${String(error)}\n`); process.exitCode = 1; });
