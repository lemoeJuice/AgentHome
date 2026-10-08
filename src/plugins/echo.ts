import type { PluginContext } from "../gateway/registry.js";

export default function registerEchoPlugin(context: PluginContext): void {
  context.registerCommand({ name: "echo", aliases: ["say"], permission: "command.echo", kind: "PLUGIN" }, async (command) => {
    const args = command.message.text.trim().replace(/^@\S+\s+(?=\/)/, "").replace(/^\/\S+\s*/, "").trim();
    return {
      text: args || "用法：/echo <text>",
      context: { type: "echo", summary: args },
    };
  });
  context.registerAgentAction({ name: "system.echo", description: "Return text without side effects", inputSchema: { type: "object", properties: { text: { type: "string" } } }, permission: "action.system.echo", pluginId: context.pluginId }, async (input) => input);
}
