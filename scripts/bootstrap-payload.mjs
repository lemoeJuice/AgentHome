import { readFile } from "node:fs/promises";

const configPath = process.env.CONFIG_PATH;
const inputPath = process.env.AGENT_HOME_BOOTSTRAP_FILE;
const source = inputPath ? inputPath : configPath;
if (!source) throw new Error("BOOTSTRAP_CONFIG_PATH_REQUIRED");
const config = JSON.parse(await readFile(source, "utf8"));
if (Object.hasOwn(config, "owner")) throw new Error("BOOTSTRAP_SINGULAR_OWNER_UNSUPPORTED");
if (!Array.isArray(config.owners) || !Array.isArray(config.systemAdmins)) throw new Error("BOOTSTRAP_IDENTITY_LISTS_REQUIRED");
if (!config.instanceId || !config.snowluma?.endpoint) throw new Error("BOOTSTRAP_CONFIG_INVALID");

const internal = {
  ...(inputPath ? (config.internal ?? {}) : {}),
  ...(process.env.AGENT_HOME_CONTROL_TOKEN ? { controlToken: process.env.AGENT_HOME_CONTROL_TOKEN } : {}),
  ...(process.env.AGENT_HOME_MCP_TOKEN ? { mcpToken: process.env.AGENT_HOME_MCP_TOKEN } : {}),
  ...(process.env.GATEWAY_MCP_CONTROL_TOKEN ? { mcpControlToken: process.env.GATEWAY_MCP_CONTROL_TOKEN } : {}),
  ...(process.env.AGENT_ARTIFACT_TRANSFER_SECRET ? { artifactTransferSecret: process.env.AGENT_ARTIFACT_TRANSFER_SECRET } : {}),
};
if (!internal.mcpToken) {
  try { internal.mcpToken = (await readFile(".agent-home/mcp-main-token", "utf8")).trim(); } catch { /* setup may inject the token later */ }
}

const payload = {
  format: "agent-home-bootstrap",
  version: 1,
  instanceId: config.instanceId,
  owners: config.owners,
  systemAdmins: config.systemAdmins,
  plugins: {
    allowedActions: config.plugins?.allowedActions ?? [],
    ...(config.plugins?.allowedPermissions !== undefined ? { allowedPermissions: config.plugins.allowedPermissions } : {}),
    ...(config.plugins?.guestAllowedActions !== undefined ? { guestAllowedActions: config.plugins.guestAllowedActions } : {}),
    ...(config.plugins?.guestAllowedPermissions !== undefined ? { guestAllowedPermissions: config.plugins.guestAllowedPermissions } : {}),
  },
  ...(Object.keys(internal).length ? { internal } : {}),
  snowluma: {
    endpoint: process.env.SNOWLUMA_AGENT_ENDPOINT || config.snowluma.endpoint,
    apiEndpoint: process.env.SNOWLUMA_AGENT_API_ENDPOINT || config.snowluma.apiEndpoint,
    reverseWebSocketPath: config.snowluma.reverseWebSocketPath || "/onebot/v11/ws",
    ...(inputPath && config.snowluma.credential ? { credential: config.snowluma.credential } : {}),
    ...(inputPath && config.snowluma.websocketCredential ? { websocketCredential: config.snowluma.websocketCredential } : {}),
    ...(process.env.SNOWLUMA_ACCESS_TOKEN ? { credential: process.env.SNOWLUMA_ACCESS_TOKEN } : {}),
    ...(process.env.SNOWLUMA_WEBSOCKET_ACCESS_TOKEN ? { websocketCredential: process.env.SNOWLUMA_WEBSOCKET_ACCESS_TOKEN } : {}),
  },
  ...(config.runtime ? { runtime: config.runtime } : {}),
  ...(config.guest ? { guest: config.guest } : {}),
  ...(config.gateway ? { gateway: config.gateway } : {}),
  ...(config.network ? { network: config.network } : {}),
};
process.stdout.write(JSON.stringify(payload));
