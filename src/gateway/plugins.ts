import { mkdir } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { AppConfig } from "../config.js";
import type { Logger } from "../shared/logger.js";
import { FilePluginState } from "./state.js";
import { AgentActionRegistry, CommandRegistry, type PluginContext, type PluginLifecycleHandle } from "./registry.js";

export interface PluginLoadFailure { pluginId: string; path: string; error: string }
export interface PluginLoadReport { loaded: string[]; failed: PluginLoadFailure[] }

class PluginLifecycle implements PluginLifecycleHandle {
  readonly signal: AbortSignal;
  private readonly lifetime = new AbortController();
  private readonly active = new Map<AbortController, Promise<unknown>>();
  private readonly cleanups: Array<() => void | Promise<void>> = [];
  private stopping: Promise<void> | undefined;
  private readonly pluginId: string;
  private readonly logger: Logger;

  constructor(pluginId: string, logger: Logger) {
    this.pluginId = pluginId;
    this.logger = logger;
    this.signal = this.lifetime.signal;
  }

  onDispose(cleanup: () => void | Promise<void>): void {
    if (this.lifetime.signal.aborted) throw new Error("PLUGIN_STOPPING");
    this.cleanups.push(cleanup);
  }

  async run<T>(invoke: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.lifetime.signal.aborted) throw new Error("PLUGIN_STOPPING");
    const controller = new AbortController();
    const abortInvocation = () => controller.abort(this.lifetime.signal.reason);
    this.lifetime.signal.addEventListener("abort", abortInvocation, { once: true });
    const operation = Promise.resolve().then(() => {
      if (controller.signal.aborted) throw new Error("PLUGIN_STOPPING");
      return invoke(controller.signal);
    });
    this.active.set(controller, operation);
    try { return await operation; }
    finally {
      this.active.delete(controller);
      this.lifetime.signal.removeEventListener("abort", abortInvocation);
    }
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopping = this.dispose();
    return this.stopping;
  }

  private async dispose(): Promise<void> {
    this.lifetime.abort(new Error("PLUGIN_STOPPING"));
    for (const controller of this.active.keys()) controller.abort(new Error("PLUGIN_STOPPING"));
    await Promise.allSettled([...this.active.values()]);
    for (const cleanup of this.cleanups.reverse()) {
      try { await cleanup(); }
      catch (error) { this.logger.error("Plugin cleanup failed", { pluginId: this.pluginId, error: String(error) }); }
    }
    this.logger.info("Plugin stopped", { pluginId: this.pluginId });
  }
}

export async function loadPlugins(config: AppConfig, commands: CommandRegistry, actions: AgentActionRegistry, logger: Logger): Promise<PluginLoadReport> {
  const report: PluginLoadReport = { loaded: [], failed: [] };
  for (const pluginPath of config.plugins.enabled) {
    const absolute = isAbsolute(pluginPath) ? pluginPath : resolve(pluginPath);
    const pluginId = basename(absolute) || pluginPath;
    const state = new FilePluginState(resolve(config.paths.pluginData, pluginId));
    const lifecycle = new PluginLifecycle(pluginId, logger);
    const stagedCommands = new CommandRegistry();
    const stagedActions = new AgentActionRegistry();
    stagedCommands.registerPluginLifecycle(lifecycle);
    const context: PluginContext = {
      pluginId,
      state,
      signal: lifecycle.signal,
      onDispose: (cleanup) => lifecycle.onDispose(cleanup),
      registerCommand: (definition, handler) => stagedCommands.register({ ...definition, pluginId, kind: "PLUGIN" }, (command) => lifecycle.run((signal) => handler({ ...command, signal })), state),
      registerAgentAction: (definition, handler) => stagedActions.register({ ...definition, pluginId }, (input, actionContext) => lifecycle.run((signal) => handler(input, { ...actionContext, signal }))),
    };
    try {
      const moduleUrl = pathToFileURL(absolute);
      moduleUrl.searchParams.set("pluginReload", String(Date.now()) + Math.random().toString(36).slice(2));
      const module = await import(moduleUrl.href) as { default?: (context: PluginContext) => void | Promise<void>; register?: (context: PluginContext) => void | Promise<void> };
      const register = module.default ?? module.register;
      if (!register) throw new Error("PLUGIN_REGISTER_EXPORT_MISSING");
      await register(context);
      await mkdir(state.root, { recursive: true });
      // Validate both registries before changing either shared registry, so a
      // collision cannot leave this plugin partially visible.
      commands.assertCanMerge(stagedCommands);
      actions.assertCanMerge(stagedActions);
      commands.merge(stagedCommands);
      actions.merge(stagedActions);
      report.loaded.push(pluginId);
      logger.info("Plugin loaded", { pluginId });
    } catch (error) {
      await lifecycle.stop();
      const failure = { pluginId, path: absolute, error: String(error) };
      report.failed.push(failure);
      logger.error("Plugin failed to load; continuing with remaining plugins", failure);
    }
  }
  logger.info("Plugin loading complete", { loaded: report.loaded.length, failed: report.failed.length });
  return report;
}
