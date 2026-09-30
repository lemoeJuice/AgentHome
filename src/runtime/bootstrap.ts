import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AppConfig } from "../config.js";
import { migrate, SqliteStore } from "../db.js";
import { runtimeMigrations } from "../schema.js";

export async function bootstrapFromStdin(stateRoot: string): Promise<void> {
  let input = "";
  for await (const chunk of process.stdin) input += String(chunk);
  const value = JSON.parse(input) as { format?: string; version?: number; instanceId?: string; systemAdmins?: Array<{ platform?: string; accountId?: string; userId?: string }>; snowluma?: { endpoint?: string; apiEndpoint?: string; reverseWebSocketPath?: string; credential?: unknown; websocketCredential?: unknown }; internal?: { controlToken?: unknown; mcpToken?: unknown; mcpControlToken?: unknown; artifactTransferSecret?: unknown }; plugins?: { allowedActions?: string[]; allowedPermissions?: string[] }; runtime?: Partial<AppConfig["runtime"]>; gateway?: Partial<AppConfig["gateway"]>; network?: Partial<AppConfig["network"]>; principalExecution?: Partial<AppConfig["principalExecution"]> };
  if (value.format !== "agent-home-bootstrap" || value.version !== 1 || !value.instanceId || !value.snowluma?.endpoint || (value.systemAdmins !== undefined && !Array.isArray(value.systemAdmins))) throw new Error("BOOTSTRAP_INVALID");
  const credential = value.snowluma.credential;
  const websocketCredential = value.snowluma.websocketCredential;
  if ((credential !== undefined && (typeof credential !== "string" || !credential)) || (websocketCredential !== undefined && (typeof websocketCredential !== "string" || !websocketCredential))) throw new Error("BOOTSTRAP_INVALID_CREDENTIAL");
  const internalSecrets: Array<[string, unknown]> = [["control-token", value.internal?.controlToken], ["mcp-main-token", value.internal?.mcpToken], ["mcp-control-token", value.internal?.mcpControlToken], ["artifact-transfer-secret", value.internal?.artifactTransferSecret]];
  if (internalSecrets.some(([, secret]) => secret !== undefined && (typeof secret !== "string" || !secret))) throw new Error("BOOTSTRAP_INVALID_INTERNAL_SECRET");
  const directories = ["config", "secrets", "data", "projects", "artifacts", "inbox"].map((name) => join(stateRoot, name));
  await Promise.all(directories.map((directory) => mkdir(directory, { recursive: true, mode: 0o700 })));
  await Promise.all(directories.map((directory) => chmod(directory, 0o700)));
  const secrets: Array<[string, string | undefined]> = [["snowluma-access-token", typeof credential === "string" ? credential : undefined], ["snowluma-websocket-access-token", typeof websocketCredential === "string" ? websocketCredential : typeof credential === "string" ? credential : undefined], ...internalSecrets.map(([name, secret]) => [name, typeof secret === "string" ? secret : undefined] as [string, string | undefined])];
  await Promise.all(secrets.filter(([, secret]) => secret !== undefined).map(async ([name, secret]) => {
    const path = join(stateRoot, "secrets", name);
    await writeFile(path, `${secret}\n`, { mode: 0o600 });
    await chmod(path, 0o600);
  }));
  const systemAdmins = (value.systemAdmins ?? []).filter((admin): admin is { platform: string; accountId: string; userId: string } => Boolean(admin.platform && admin.userId)).map((admin) => ({ platform: admin.platform, accountId: admin.accountId ?? "default", userId: admin.userId }));
  const allowedActions = value.plugins?.allowedActions?.filter((action): action is string => typeof action === "string" && Boolean(action)) ?? [];
  const readActions = (actions: unknown): string[] => Array.isArray(actions) ? [...new Set(actions.filter((action): action is string => typeof action === "string" && Boolean(action)))] : [];
  const config = { instanceId: value.instanceId, systemAdmins, ...(value.gateway ? { gateway: value.gateway } : {}), ...(value.network ? { network: value.network } : {}), snowluma: { endpoint: value.snowluma.endpoint, apiEndpoint: value.snowluma.apiEndpoint ?? "http://127.0.0.1:3000", reverseWebSocketPath: value.snowluma.reverseWebSocketPath ?? "/onebot/v11/ws" }, ...(value.runtime ? { runtime: value.runtime } : {}), ...(value.principalExecution ? { principalExecution: value.principalExecution } : {}), plugins: { allowedActions: [...new Set(allowedActions)], allowedPermissions: readActions(value.plugins?.allowedPermissions) } };
  await writeFile(join(stateRoot, "config", "bootstrap.json"), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await chmod(join(stateRoot, "config", "bootstrap.json"), 0o600);
  const database = new SqliteStore(join(stateRoot, "data", "agent.db"));
   try {
     migrate(database, runtimeMigrations);
   } finally { database.close(); }
  process.stdout.write(JSON.stringify({ status: "initialized", stateRoot, instanceId: value.instanceId }) + "\n");
}
