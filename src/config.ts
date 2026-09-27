import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { LogLevel } from "./shared/logger.js";

export interface AppConfig {
  instanceId: string;
  owners?: Array<{ platform: string; accountId: string; userId: string }>;
  /** @deprecated Use owners. Kept for existing configuration and integrations. */
  owner?: { platform: string; accountId: string; userId: string };
  gateway: { mcpPort: number; mcpHost?: string; mcpActionTimeoutMs: number };
  network: { modelProxyUrl?: string };
  paths: { gatewayState: string; pluginData: string; backupDir: string; stateRoot: string; runtimeSocket: string };
  snowluma: {
    accountId: string;
    endpoint: string;
    apiEndpoint: string;
    reverseWebSocketPath: string;
    reconnectMs: number;
    requestTimeoutMs: number;
  };
  chat: {
    global: { commandRequireMention: boolean; naturalLanguageMode: "observe_all" | "explicit_wake" };
    qq: { commandRequireMention: boolean; naturalLanguageMode: "observe_all" | "explicit_wake" };
    conversationOverrides: Record<string, Partial<{ commandRequireMention: boolean; naturalLanguageMode: "observe_all" | "explicit_wake" }>>;
    accountOverrides?: Record<string, Partial<{ commandRequireMention: boolean; naturalLanguageMode: "observe_all" | "explicit_wake" }>>;
  };
  agent: { persona: string };
  runtime: { maxInFlight: number; maxWorkers: number; maxWorkersTotal: number; maxWorkersPerProject: number; maxWorkersPerRequester: number; maxTasks: number; maxTasksPerRequester: number; maxTasksPerPrincipal: number; maxArtifactBytes: number; piCommand: string; piTimeoutMs: number; workerSandboxCommand: string; piAgentDir: string };
  guest: { enabled: boolean; maxWorkersPerPrincipal: number; taskTimeoutMs: number; commandTimeoutMs: number; cpuSeconds: number; memoryBytes: number; pids: number; maxFileBytes: number; workspaceQuotaBytes: number; cacheQuotaBytes: number; artifactQuotaBytes: number };
  memory: { rawEpisodeDays: number | null; keepExplicitForever: boolean; keepProvenanceForActiveFacts: boolean; maxPromptBytes: number };
  plugins: { enabled: string[]; allowedActions?: string[]; allowedPermissions?: string[]; guestAllowedActions?: string[]; guestAllowedPermissions?: string[] };
  logging: { level: LogLevel };
}

const defaults: AppConfig = {
  instanceId: "default",
  gateway: { mcpPort: 8787, mcpActionTimeoutMs: 30_000 },
  network: { modelProxyUrl: "http://host.containers.internal:7897" },
  paths: {
    gatewayState: "./runtime-state/gateway.sqlite",
    pluginData: "./runtime-state/plugin-data",
    backupDir: "./backups",
    stateRoot: "/state",
    runtimeSocket: "/run/agent-home/control.sock",
  },
  snowluma: {
    accountId: "default",
    endpoint: "ws://127.0.0.1:3001",
    apiEndpoint: "http://127.0.0.1:3000",
    reverseWebSocketPath: "/onebot/v11/ws",
    reconnectMs: 2000,
    requestTimeoutMs: 15000,
  },
  chat: {
    global: { commandRequireMention: false, naturalLanguageMode: "explicit_wake" },
    qq: { commandRequireMention: false, naturalLanguageMode: "explicit_wake" },
    conversationOverrides: {},
    accountOverrides: {},
  },
  agent: { persona: "" },
  runtime: { maxInFlight: 16, maxWorkers: 2, maxWorkersTotal: 8, maxWorkersPerProject: 2, maxWorkersPerRequester: 4, maxTasks: 32, maxTasksPerRequester: 8, maxTasksPerPrincipal: 8, maxArtifactBytes: 50 * 1024 * 1024, piCommand: "pi", piTimeoutMs: 60 * 60 * 1000, workerSandboxCommand: "bwrap", piAgentDir: "/state/model/pi/agent" },
  guest: { enabled: false, maxWorkersPerPrincipal: 1, taskTimeoutMs: 30 * 60 * 1000, commandTimeoutMs: 10 * 60 * 1000, cpuSeconds: 600, memoryBytes: 16 * 1024 * 1024 * 1024, pids: 128, maxFileBytes: 512 * 1024 * 1024, workspaceQuotaBytes: 2 * 1024 * 1024 * 1024, cacheQuotaBytes: 1024 * 1024 * 1024, artifactQuotaBytes: 512 * 1024 * 1024 },
  memory: { rawEpisodeDays: 30, keepExplicitForever: true, keepProvenanceForActiveFacts: true, maxPromptBytes: 24 * 1024 },
  plugins: { enabled: [], allowedActions: [], allowedPermissions: [], guestAllowedActions: [], guestAllowedPermissions: [] },
  logging: { level: "info" },
};

function merge<T>(base: T, value: Partial<T>): T {
  if (Array.isArray(base) || Array.isArray(value)) return (value ?? base) as T;
  if (typeof base !== "object" || base === null || typeof value !== "object" || value === null) return (value ?? base) as T;
  const output = { ...(base as Record<string, unknown>) };
  for (const [key, incoming] of Object.entries(value as Record<string, unknown>)) {
    const current = output[key];
    output[key] = typeof current === "object" && current !== null && typeof incoming === "object" && incoming !== null
      ? merge(current, incoming as never)
      : incoming;
  }
  return output as T;
}

export async function loadConfig(path = process.env.AGENT_HOME_CONFIG ?? "./config/agent-home.json"): Promise<AppConfig> {
  const configPath = resolve(path);
  const configDirectory = dirname(configPath);
  let fileConfig: Partial<AppConfig> = {};
  try {
    fileConfig = JSON.parse(await readFile(configPath, "utf8")) as Partial<AppConfig>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const stateRoot = process.env.AGENT_HOME_STATE ?? "/state";
    try {
      const bootstrap = JSON.parse(await readFile(resolve(stateRoot, "config/bootstrap.json"), "utf8")) as Partial<AppConfig>;
      fileConfig = { ...bootstrap, paths: { ...defaults.paths, stateRoot } };
    } catch { /* doctor will report the missing configuration below */ }
  }
  const legacyOwner = fileConfig.owner;
  const configuredOwners = fileConfig.owners ?? (legacyOwner ? [legacyOwner] : []);
  if (!Array.isArray(configuredOwners) || configuredOwners.some((owner) => !owner || typeof owner.platform !== "string" || typeof owner.accountId !== "string" || typeof owner.userId !== "string")) throw new Error("CONFIG_INVALID: owners");
  const owners = configuredOwners.filter((owner) => owner.platform && owner.accountId && owner.userId && !owner.userId.startsWith("REPLACE_"));
  const { owner: _legacyOwner, ...withoutLegacyOwner } = fileConfig;
  fileConfig = { ...withoutLegacyOwner, ...(fileConfig.owners !== undefined || legacyOwner ? { owners } : {}) };
  if (fileConfig.owners !== undefined) fileConfig.owners = owners;
  const config = merge(defaults, fileConfig);
  for (const key of ["gatewayState", "pluginData", "backupDir"] as const) {
    if (!config.paths[key].startsWith("/")) config.paths[key] = resolve(configDirectory, config.paths[key]);
  }
  if (process.env.PI_COMMAND) config.runtime.piCommand = process.env.PI_COMMAND;
  if (process.env.PI_AGENT_DIR) config.runtime.piAgentDir = process.env.PI_AGENT_DIR;
  if (resolve(config.runtime.piAgentDir) === resolve("/state/model/pi/agent")) config.runtime.piAgentDir = join(config.paths.stateRoot, "model", "pi", "agent");
  if (resolve(config.runtime.piAgentDir) === resolve(config.paths.stateRoot, "home", ".pi", "agent")) config.runtime.piAgentDir = join(config.paths.stateRoot, "model", "pi", "agent");
  // Node 22's bundled undici reserves substantial WebAssembly virtual address
  // space. The former 2 GiB RLIMIT_AS prevented Pi from starting and broke fetch/npm.
  if (config.guest.memoryBytes === 2 * 1024 * 1024 * 1024) config.guest.memoryBytes = 16 * 1024 * 1024 * 1024;
  if (process.env.AGENT_HOME_WORKER_SANDBOX) config.runtime.workerSandboxCommand = process.env.AGENT_HOME_WORKER_SANDBOX;
  if (process.env.AGENT_HOME_MODEL_PROXY_URL !== undefined) config.network.modelProxyUrl = process.env.AGENT_HOME_MODEL_PROXY_URL || undefined;
  if (process.env.GATEWAY_MCP_PORT !== undefined) config.gateway.mcpPort = positiveIntegerEnv("GATEWAY_MCP_PORT", config.gateway.mcpPort);
  if (process.env.GATEWAY_MCP_HOST !== undefined) config.gateway.mcpHost = process.env.GATEWAY_MCP_HOST;
  if (process.env.GATEWAY_MCP_ACTION_TIMEOUT_MS !== undefined) config.gateway.mcpActionTimeoutMs = positiveIntegerEnv("GATEWAY_MCP_ACTION_TIMEOUT_MS", config.gateway.mcpActionTimeoutMs);
  if (process.env.AGENT_HOME_LOG_LEVEL) config.logging.level = process.env.AGENT_HOME_LOG_LEVEL as LogLevel;
  delete (config.runtime as AppConfig["runtime"] & { piProvider?: string }).piProvider;
  delete (config.runtime as AppConfig["runtime"] & { piModel?: string }).piModel;
  validateConfig(config);
  return config;
}

export function configuredOwners(config: Pick<AppConfig, "owners" | "owner">): NonNullable<AppConfig["owners"]> {
  return config.owners ?? (config.owner ? [config.owner] : []);
}

export function validateConfig(config: AppConfig): void {
  const required = [config.instanceId, config.snowluma.endpoint, config.snowluma.apiEndpoint];
  if (required.some((value) => !value)) throw new Error("CONFIG_MISSING: instance and SnowLuma endpoints are required");
  if (config.owners?.some((owner) => !owner.platform || !owner.accountId || !owner.userId)) throw new Error("CONFIG_INVALID: owners");
  if (!Number.isInteger(config.gateway.mcpPort) || config.gateway.mcpPort < 0 || config.gateway.mcpPort > 65535) throw new Error("CONFIG_INVALID: gateway.mcpPort");
  if (!Number.isSafeInteger(config.gateway.mcpActionTimeoutMs) || config.gateway.mcpActionTimeoutMs < 1) throw new Error("CONFIG_INVALID: gateway.mcpActionTimeoutMs");
  if (!Number.isInteger(config.runtime.maxInFlight) || config.runtime.maxInFlight < 1) throw new Error("CONFIG_INVALID: runtime.maxInFlight");
  if (!Number.isInteger(config.runtime.maxWorkers) || config.runtime.maxWorkers < 1) throw new Error("CONFIG_INVALID: runtime.maxWorkers");
  for (const key of ["maxWorkersTotal", "maxWorkersPerProject", "maxWorkersPerRequester", "maxTasks", "maxTasksPerRequester", "maxTasksPerPrincipal"] as const) if (!Number.isInteger(config.runtime[key]) || config.runtime[key] < 1) throw new Error(`CONFIG_INVALID: runtime.${key}`);
  if (typeof config.guest.enabled !== "boolean") throw new Error("CONFIG_INVALID: guest.enabled");
  for (const key of ["maxWorkersPerPrincipal", "taskTimeoutMs", "commandTimeoutMs", "cpuSeconds", "memoryBytes", "pids", "maxFileBytes", "workspaceQuotaBytes", "cacheQuotaBytes", "artifactQuotaBytes"] as const) if (!Number.isSafeInteger(config.guest[key]) || config.guest[key] < 1) throw new Error(`CONFIG_INVALID: guest.${key}`);
  if (config.guest.enabled && config.guest.memoryBytes < 16 * 1024 * 1024 * 1024) throw new Error("CONFIG_INVALID: guest.memoryBytes must be at least 16 GiB for Node 22 Pi/npm WebAssembly address space");
  if (config.memory.rawEpisodeDays !== null && (!Number.isInteger(config.memory.rawEpisodeDays) || config.memory.rawEpisodeDays < 1)) throw new Error("CONFIG_INVALID: memory.rawEpisodeDays");
  if (typeof config.memory.keepExplicitForever !== "boolean" || typeof config.memory.keepProvenanceForActiveFacts !== "boolean") throw new Error("CONFIG_INVALID: memory.retention");
  if (!Number.isInteger(config.memory.maxPromptBytes) || config.memory.maxPromptBytes < 1024) throw new Error("CONFIG_INVALID: memory.maxPromptBytes");
  if (config.chat.qq.naturalLanguageMode !== "observe_all" && config.chat.qq.naturalLanguageMode !== "explicit_wake") throw new Error("CONFIG_INVALID: naturalLanguageMode");
  if (typeof config.agent.persona !== "string" || config.agent.persona.length > 12_000) throw new Error("CONFIG_INVALID: agent.persona");
}

function positiveIntegerEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name}_INVALID`);
  return parsed;
}

export function snowlumaAccessToken(config: AppConfig): string | undefined {
  return readSnowLumaSecret(config, "snowluma-access-token");
}

export function snowlumaWebSocketAccessToken(config: AppConfig): string | undefined {
  return readSnowLumaSecret(config, "snowluma-websocket-access-token") ?? snowlumaAccessToken(config);
}

function readSnowLumaSecret(config: AppConfig, name: string): string | undefined {
  const paths = [join(config.paths.stateRoot, "secrets", name)];
  if (process.env.AGENT_HOME_HOST_SECRET_ROOT) paths.push(join(process.env.AGENT_HOME_HOST_SECRET_ROOT, name));
  for (const path of paths) {
    try {
      const value = readFileSync(path, "utf8").trim();
      if (value) return value;
    } catch { /* Try the next private deployment path. */ }
  }
  return undefined;
}
