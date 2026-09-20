import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AppConfig } from "../config.js";

export async function bootstrapFromStdin(stateRoot: string): Promise<void> {
  let input = "";
  for await (const chunk of process.stdin) input += String(chunk);
  const value = JSON.parse(input) as { format?: string; version?: number; instanceId?: string; owner?: { platform?: string; userId?: string }; snowluma?: { endpoint?: string; apiEndpoint?: string; credential?: string } };
  if (value.format !== "agent-home-bootstrap" || value.version !== 1 || !value.instanceId || !value.owner?.platform || !value.owner.userId || !value.snowluma?.endpoint || !value.snowluma.apiEndpoint) throw new Error("BOOTSTRAP_INVALID");
  await Promise.all([mkdir(join(stateRoot, "config"), { recursive: true }), mkdir(join(stateRoot, "secrets"), { recursive: true }), mkdir(join(stateRoot, "data"), { recursive: true }), mkdir(join(stateRoot, "projects"), { recursive: true }), mkdir(join(stateRoot, "artifacts"), { recursive: true }), mkdir(join(stateRoot, "inbox"), { recursive: true })]);
  const config = { instanceId: value.instanceId, owner: { platform: value.owner.platform, accountId: "default", userId: value.owner.userId }, snowluma: { endpoint: value.snowluma.endpoint, apiEndpoint: value.snowluma.apiEndpoint } };
  await writeFile(join(stateRoot, "config", "bootstrap.json"), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  if (value.snowluma.credential) await writeFile(join(stateRoot, "secrets", "snowluma-access-token"), `${value.snowluma.credential}\n`, { mode: 0o600 });
  process.stdout.write(JSON.stringify({ status: "initialized", stateRoot, instanceId: value.instanceId }) + "\n");
}
