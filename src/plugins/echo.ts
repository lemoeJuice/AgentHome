import type { PluginContext } from "../gateway/registry.js";

export default function registerEchoPlugin(context: PluginContext): void {
  context.registerCommand({ name: "echo", aliases: ["say"], permission: "command.echo", kind: "PLUGIN" }, async (command) => ({
    text: command.args.length ? command.args.join(" ") : "用法：/echo <text>",
    context: { type: "echo", summary: command.args.join(" ") },
  }));
  context.registerAgentAction({ name: "system.echo", description: "Return text without side effects", inputSchema: { type: "object", properties: { text: { type: "string" } } }, permission: "action.system.echo", pluginId: context.pluginId }, async (input) => input);
}
