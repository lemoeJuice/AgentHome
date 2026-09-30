import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const configPath = resolve(process.argv[2] ?? process.env.AGENT_HOME_CONFIG ?? "./config.json");
const config = JSON.parse(await readFile(configPath, "utf8"));
const migratedOwnerAlias = !Array.isArray(config.owners) && Boolean(config.owner);
if (!Array.isArray(config.owners) && config.owner) config.owners = [config.owner];
delete config.owner;
config.owners ??= [];
if (config.owners.some((owner) => !owner?.platform || !owner?.userId)) throw new Error("CONFIG_INVALID: owners");
if (!Array.isArray(config.systemAdmins)) config.systemAdmins = config.owners.map((owner) => ({ ...owner }));
if (config.systemAdmins.some((admin) => !admin?.platform || !admin?.userId)) throw new Error("CONFIG_INVALID: systemAdmins");
if (config.guest?.memoryBytes === 2 * 1024 * 1024 * 1024) config.guest.memoryBytes = 16 * 1024 * 1024 * 1024;
if (config.runtime?.piAgentDir && ["/state/home/.pi/agent", "/state/principals/uid-10001/home/.pi/agent"].includes(config.runtime.piAgentDir)) {
  config.runtime.piAgentDir = `${config.paths?.stateRoot ?? "/state"}/model/pi/agent`;
}
const temporaryPath = join(dirname(configPath), `.config-migration-${process.pid}.tmp`);
await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
await rename(temporaryPath, configPath);
console.log(JSON.stringify({ owners: config.owners.length, systemAdmins: config.systemAdmins.length, migratedOwnerAlias }));
