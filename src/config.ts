import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { LogLevel } from "./shared/logger.js";

export interface AppConfig {
  instanceId: string;
  owner: { platform: string; accountId: string; userId: string };
  paths: { gatewayState: string; pluginData: string; backupDir: string; stateRoot: string; runtimeSocket: string };
  snowluma: {
    accountId: string;
    endpoint: string;
    apiEndpoint: string;
    accessTokenEnv: string;
    reverseWebSocketPath: string;
    reconnectMs: number;
    requestTimeoutMs: number;
  };
  chat: {
    global: { commandRequireMention: boolean; naturalLanguageMode: "observe_all" | "explicit_wake" };
    qq: { commandRequireMention: boolean; naturalLanguageMode: "observe_all" | "explicit_wake" };
    conversationOverrides: Record<string, Partial<{ commandRequireMention: boolean; naturalLanguageMode: "observe_all" | "explicit_wake" }>>;
  };
  runtime: { maxInFlight: number; maxWorkers: number; maxArtifactBytes: number; piCommand: string; piTimeoutMs: number };
  plugins: { enabled: string[] };
  logging: { level: LogLevel };
}

const defaults: AppConfig = {
  instanceId: "default",
  owner: { platform: "qq", accountId: "default", userId: "" },
  paths: {
    gatewayState: "./runtime-state/gateway.sqlite",
    pluginData: "./runtime-state/plugin-data",
    backupDir: "./backups",
    stateRoot: "/state",
    runtimeSocket: "/run/agent-home/control.sock",
  },
  snowluma: {
    accountId: "default",
    endpoint: "ws://127.0.0.1:6700",
    apiEndpoint: "http://127.0.0.1:5700",
    accessTokenEnv: "SNOWLUMA_ACCESS_TOKEN",
    reverseWebSocketPath: "/onebot/v11/ws",
    reconnectMs: 2000,
    requestTimeoutMs: 15000,
  },
  chat: {
    global: { commandRequireMention: false, naturalLanguageMode: "explicit_wake" },
    qq: { commandRequireMention: false, naturalLanguageMode: "explicit_wake" },
    conversationOverrides: {},
  },
  runtime: { maxInFlight: 16, maxWorkers: 2, maxArtifactBytes: 50 * 1024 * 1024, piCommand: "pi", piTimeoutMs: 60 * 60 * 1000 },
  plugins: { enabled: [] },
  logging: { level: "info" },
};

function merge<T>(base: T, value: Partial<T>): T {
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
  let fileConfig: Partial<AppConfig> = {};
  try {
    fileConfig = JSON.parse(await readFile(resolve(path), "utf8")) as Partial<AppConfig>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const stateRoot = process.env.AGENT_HOME_STATE ?? "/state";
    try {
      const bootstrap = JSON.parse(await readFile(resolve(stateRoot, "config/bootstrap.json"), "utf8")) as Partial<AppConfig>;
      fileConfig = { ...bootstrap, paths: { ...defaults.paths, stateRoot } };
    } catch { /* doctor will report the missing configuration below */ }
  }
  const config = merge(defaults, fileConfig);
  const configDirectory = resolve(path, "..");
  for (const key of ["gatewayState", "pluginData", "backupDir"] as const) {
    if (!config.paths[key].startsWith("/")) config.paths[key] = resolve(configDirectory, config.paths[key]);
  }
  if (process.env.PI_COMMAND) config.runtime.piCommand = process.env.PI_COMMAND;
  if (process.env.AGENT_HOME_LOG_LEVEL) config.logging.level = process.env.AGENT_HOME_LOG_LEVEL as LogLevel;
  validateConfig(config);
  return config;
}

export function validateConfig(config: AppConfig): void {
  const required = [config.instanceId, config.owner.platform, config.owner.accountId, config.snowluma.endpoint, config.snowluma.apiEndpoint];
  if (required.some((value) => !value)) throw new Error("CONFIG_MISSING: instance, owner and SnowLuma endpoints are required");
  if (!config.owner.userId || config.owner.userId.startsWith("REPLACE_")) throw new Error("CONFIG_MISSING: owner.userId is not configured");
  if (!Number.isInteger(config.runtime.maxInFlight) || config.runtime.maxInFlight < 1) throw new Error("CONFIG_INVALID: runtime.maxInFlight");
  if (!Number.isInteger(config.runtime.maxWorkers) || config.runtime.maxWorkers < 1) throw new Error("CONFIG_INVALID: runtime.maxWorkers");
  if (config.chat.qq.naturalLanguageMode !== "observe_all" && config.chat.qq.naturalLanguageMode !== "explicit_wake") throw new Error("CONFIG_INVALID: naturalLanguageMode");
}

export function secretFromConfig(config: AppConfig): string | undefined {
  const environment = process.env[config.snowluma.accessTokenEnv];
  if (environment) return environment;
  try { return readFileSync(resolve(config.paths.stateRoot, "secrets/snowluma-access-token"), "utf8").trim() || undefined; } catch { return undefined; }
}
