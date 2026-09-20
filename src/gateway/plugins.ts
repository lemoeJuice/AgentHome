import { mkdir } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { AppConfig } from "../config.js";
import type { Logger } from "../shared/logger.js";
import { FilePluginState } from "./state.js";
import { AgentActionRegistry, CommandRegistry, type PluginContext } from "./registry.js";

export async function loadPlugins(config: AppConfig, commands: CommandRegistry, actions: AgentActionRegistry, logger: Logger): Promise<void> {
  for (const pluginPath of config.plugins.enabled) {
    const absolute = isAbsolute(pluginPath) ? pluginPath : resolve(pluginPath);
    const pluginId = absolute.split("/").pop() ?? pluginPath;
    const state = new FilePluginState(resolve(config.paths.pluginData, pluginId));
    const context: PluginContext = {
      pluginId,
      state,
      registerCommand: (definition, handler) => commands.register({ ...definition, pluginId, kind: "PLUGIN" }, handler, state),
      registerAgentAction: (definition, handler) => actions.register({ ...definition, pluginId }, handler),
    };
    try {
      const module = await import(absolute) as { default?: (context: PluginContext) => void | Promise<void>; register?: (context: PluginContext) => void | Promise<void> };
      const register = module.default ?? module.register;
      if (!register) throw new Error("PLUGIN_REGISTER_EXPORT_MISSING");
      await register(context);
      await mkdir(state.root, { recursive: true });
      logger.info("Plugin loaded", { pluginId });
    } catch (error) {
      logger.error("Plugin failed to load", { pluginId, error: String(error) });
      throw new Error(`PLUGIN_LOAD_FAILED:${pluginId}`);
    }
  }
}
