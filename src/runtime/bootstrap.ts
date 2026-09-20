import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { migrate, SqliteStore } from "../db.js";
import { runtimeMigrations } from "../schema.js";

export async function bootstrapFromStdin(stateRoot: string): Promise<void> {
  let input = "";
  for await (const chunk of process.stdin) input += String(chunk);
  const value = JSON.parse(input) as { format?: string; version?: number; instanceId?: string; owner?: { platform?: string; accountId?: string; userId?: string }; snowluma?: { endpoint?: string; apiEndpoint?: string; credential?: string } };
  if (value.format !== "agent-home-bootstrap" || value.version !== 1 || !value.instanceId || !value.owner?.platform || !value.owner.userId || !value.snowluma?.endpoint) throw new Error("BOOTSTRAP_INVALID");
  const directories = ["config", "secrets", "data", "projects", "artifacts", "inbox"].map((name) => join(stateRoot, name));
  await Promise.all(directories.map((directory) => mkdir(directory, { recursive: true, mode: 0o700 })));
  await Promise.all(directories.map((directory) => chmod(directory, 0o700)));
  const config = { instanceId: value.instanceId, owner: { platform: value.owner.platform, accountId: value.owner.accountId ?? "default", userId: value.owner.userId }, snowluma: { endpoint: value.snowluma.endpoint, apiEndpoint: value.snowluma.apiEndpoint ?? "http://127.0.0.1:3000" } };
  await writeFile(join(stateRoot, "config", "bootstrap.json"), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await chmod(join(stateRoot, "config", "bootstrap.json"), 0o600);
  if (value.snowluma.credential) {
    const secretPath = join(stateRoot, "secrets", "snowluma-access-token");
    await writeFile(secretPath, `${value.snowluma.credential}\n`, { mode: 0o600 });
    await chmod(secretPath, 0o600);
  }
  const database = new SqliteStore(join(stateRoot, "data", "agent.db"));
  try { migrate(database, runtimeMigrations); } finally { database.close(); }
  process.stdout.write(JSON.stringify({ status: "initialized", stateRoot, instanceId: value.instanceId }) + "\n");
}
