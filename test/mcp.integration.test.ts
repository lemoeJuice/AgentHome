import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AgentActionRegistry } from "../src/gateway/registry.ts";
import { GatewayMcpServer } from "../src/gateway/mcp.ts";
import { Logger } from "../src/shared/logger.ts";

const execFileAsync = promisify(execFile);

test("real Podman container reaches authenticated Gateway MCP", { skip: process.env.AGENT_HOME_RUN_INTEGRATION !== "1" }, async () => {
  const actions = new AgentActionRegistry();
  actions.register({ name: "project.read", description: "read project", permission: "project.read", inputSchema: { type: "object" }, pluginId: "integration" }, async (_input, context) => context);
  const server = new GatewayMcpServer(actions, 0, new Logger("integration", "error"), { host: "0.0.0.0", token: "main-token", workerCapabilityResolver: (token) => token === "worker-token" ? { taskId: "task-1", workerId: "worker-1", allowedActions: ["project.read"], allowedPermissions: ["project.read"] } : undefined, allowedActions: ["project.read"], allowedPermissions: ["project.read"] });
  await server.start();
  try {
    const endpoint = `http://127.0.0.1:${server.getPort()}/mcp`;
    const podman = process.env.PODMAN_COMMAND ?? "podman";
    const image = process.env.AGENT_HOME_INTEGRATION_IMAGE ?? "node:22-bookworm-slim";
    const script = `(async()=>{const call=async(t,p)=>{const r=await fetch(process.env.MCP,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+t},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'invoke_action',params:p})});return {status:r.status,body:await r.json()}}; const ok=await call('worker-token',{name:'project.read',taskId:'forged-task',capabilities:{projects:['*']},input:{}}); if(ok.status!==200||ok.body.result.taskId!=='task-1')throw Error('worker binding failed'); const bad=await call('wrong-token',{name:'project.read',input:{}}); if(bad.status!==401)throw Error('auth failed'); const denied=await call('worker-token',{name:'hidden',input:{}}); if(denied.status!==404)throw Error('action boundary failed');})().catch((error)=>{console.error(error);process.exitCode=1});`;
    await execFileAsync(podman, ["run", "--rm", "--network", "bridge", "-e", `MCP=http://host.containers.internal:${server.getPort()}/mcp`, image, "node", "-e", script], { timeout: 120_000 });
    assert.ok(true);
  } finally {
    await server.stop();
  }
});
