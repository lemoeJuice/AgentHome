import { access, mkdir } from "node:fs/promises";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AppConfig } from "../config.js";
import { snowlumaAccessToken } from "../config.js";
import type { Logger } from "../shared/logger.js";

type JsonRpcResponse = {
  jsonrpc?: string;
  id?: number;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
};

export type SnowLumaMcpExecution = { input_file?: string };

export function snowlumaMcpServerPath(): string {
  return process.env.SNOWLUMA_MCP_SERVER ?? fileURLToPath(new URL("../../node_modules/@snowluma/mcp/dist/server.js", import.meta.url));
}

export async function checkSnowLumaMcpInstallation(): Promise<boolean> {
  try { await access(snowlumaMcpServerPath()); return true; } catch { return false; }
}

export interface SnowLumaMcpActions {
  listActions(category?: string): Promise<unknown>;
  searchActions(query: string): Promise<unknown>;
  getAction(name: string): Promise<unknown>;
  queryAction<T>(action: string, params?: Record<string, unknown>): Promise<T>;
  invokeAction<T>(action: string, params?: Record<string, unknown>, execution?: SnowLumaMcpExecution): Promise<T>;
  stop(): Promise<void>;
}

type PendingRequest = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

export class SnowLumaMcpClient implements SnowLumaMcpActions {
  private readonly endpoint: string;
  private readonly token: string | undefined;
  private readonly timeoutMs: number;
  private readonly maxStreamBytes: number;
  private readonly streamDir: string;
  private readonly uploadRoot: string;
  private readonly logger: Logger;
  private process: ChildProcessWithoutNullStreams | undefined;
  private startPromise: Promise<void> | undefined;
  private initialized = false;
  private nextId = 1;
  private stdoutBuffer = "";
  private readonly pending = new Map<number, PendingRequest>();

  constructor(config: AppConfig, logger: Logger) {
    this.endpoint = config.snowluma.apiEndpoint.endsWith("/") ? config.snowluma.apiEndpoint : `${config.snowluma.apiEndpoint}/`;
    this.token = snowlumaAccessToken(config);
    this.timeoutMs = config.snowluma.requestTimeoutMs;
    this.maxStreamBytes = config.runtime.maxArtifactBytes;
    this.streamDir = join(config.paths.stateRoot, "snowluma", "mcp", "streams");
    this.uploadRoot = join(config.paths.stateRoot, "snowluma", "mcp", "uploads");
    this.logger = logger.child("snowluma-mcp");
  }

  listActions(category?: string): Promise<unknown> {
    return this.callTool("list_actions", category ? { category } : {});
  }

  searchActions(query: string): Promise<unknown> {
    return this.callTool("search_actions", { query });
  }

  getAction(name: string): Promise<unknown> {
    return this.callTool("get_action", { name });
  }

  async queryAction<T>(action: string, params: Record<string, unknown> = {}): Promise<T> {
    return this.callAction<T>("query_action", action, params);
  }

  async invokeAction<T>(action: string, params: Record<string, unknown> = {}, execution?: SnowLumaMcpExecution): Promise<T> {
    return this.callAction<T>("invoke_action", action, params, execution);
  }

  async stop(): Promise<void> {
    const child = this.process;
    this.process = undefined;
    this.initialized = false;
    this.startPromise = undefined;
    if (!child) return;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("SNOWLUMA_MCP_STOPPED"));
    }
    this.pending.clear();
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const finish = (): void => { child.removeListener("exit", finish); child.removeListener("error", finish); resolve(); };
      child.once("exit", finish);
      child.once("error", finish);
      if (child.exitCode !== null || child.signalCode !== null) finish();
      else if (!child.kill()) finish();
    });
  }

  private async callAction<T>(tool: "query_action" | "invoke_action", action: string, params: Record<string, unknown>, execution?: SnowLumaMcpExecution): Promise<T> {
    const args: Record<string, unknown> = { action, params };
    if (execution) args.execution = execution;
    const result = await this.callTool(tool, args);
    if (this.isOneBotEnvelope(result)) {
      if (result.retcode !== 0) throw new Error(`ONEBOT_ACTION_FAILED:${action}:${String(result.wording ?? result.message ?? result.retcode)}`);
      return result.data as T;
    }
    return result as T;
  }

  private async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    await this.start();
    const result = await this.request("tools/call", { name, arguments: args });
    if (!result || typeof result !== "object") throw new Error(`SNOWLUMA_MCP_INVALID_RESULT:${name}`);
    const toolResult = result as { isError?: boolean; content?: unknown };
    const content = Array.isArray(toolResult.content) ? toolResult.content : [];
    const text = content.filter((item): item is { type: "text"; text: string } => Boolean(item && typeof item === "object" && (item as Record<string, unknown>).type === "text" && typeof (item as Record<string, unknown>).text === "string")).map((item) => item.text).join("\n");
    if (toolResult.isError) throw new Error(text || `SNOWLUMA_MCP_TOOL_FAILED:${name}`);
    if (!text) return result;
    try { return JSON.parse(text) as unknown; } catch { return text; }
  }

  private async start(): Promise<void> {
    if (this.initialized) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.spawnAndInitialize();
    try { await this.startPromise; } catch (error) { await this.stop(); throw error; }
  }

  private async spawnAndInitialize(): Promise<void> {
    await mkdir(this.streamDir, { recursive: true, mode: 0o700 });
    await mkdir(this.uploadRoot, { recursive: true, mode: 0o700 });
    const serverPath = snowlumaMcpServerPath();
    const command = process.env.SNOWLUMA_MCP_COMMAND ?? process.execPath;
    const args = process.env.SNOWLUMA_MCP_ARGS ? JSON.parse(process.env.SNOWLUMA_MCP_ARGS) as string[] : [serverPath];
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) throw new Error("SNOWLUMA_MCP_ARGS_INVALID");
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "/tmp",
        ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
        SNOWLUMA_MCP_ENDPOINT: this.endpoint,
        ...(this.token ? { SNOWLUMA_MCP_TOKEN: this.token } : {}),
        SNOWLUMA_MCP_MODE: "write",
        SNOWLUMA_MCP_STREAM_DIR: this.streamDir,
        SNOWLUMA_MCP_UPLOAD_ROOT: this.uploadRoot,
        SNOWLUMA_MCP_MAX_STREAM_BYTES: String(this.maxStreamBytes),
      },
    });
    this.process = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.handleStdout(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => this.logger.debug("MCP server", { output: chunk.trim() }));
    child.on("error", (error) => this.failPending(new Error(`SNOWLUMA_MCP_PROCESS_FAILED:${error.message}`)));
    child.on("exit", (code, signal) => {
      this.initialized = false;
      if (this.process === child) this.process = undefined;
      this.failPending(new Error(`SNOWLUMA_MCP_EXITED:${code ?? "signal"}:${signal ?? ""}`));
    });
    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "agent-home", version: "0.1.0" },
    });
    this.notify("notifications/initialized", {});
    this.initialized = true;
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let newline = this.stdoutBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line) {
        let message: JsonRpcResponse;
        try { message = JSON.parse(line) as JsonRpcResponse; } catch (error) {
          this.failPending(new Error(`SNOWLUMA_MCP_INVALID_JSON:${error instanceof Error ? error.message : String(error)}`));
          newline = this.stdoutBuffer.indexOf("\n");
          continue;
        }
        if (typeof message.id === "number") {
          const pending = this.pending.get(message.id);
          if (pending) {
            this.pending.delete(message.id);
            clearTimeout(pending.timer);
            if (message.error) pending.reject(new Error(`SNOWLUMA_MCP_RPC_ERROR:${message.error.message ?? message.error.code ?? "unknown"}`));
            else pending.resolve(message.result);
          }
        }
      }
      newline = this.stdoutBuffer.indexOf("\n");
    }
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const child = this.process;
    if (!child) return Promise.reject(new Error("SNOWLUMA_MCP_NOT_RUNNING"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`SNOWLUMA_MCP_TIMEOUT:${method}`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error(`SNOWLUMA_MCP_WRITE_FAILED:${error.message}`));
      });
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.process?.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  private failPending(error: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }

  private isOneBotEnvelope(value: unknown): value is { retcode: number; data?: unknown; wording?: string; message?: string } {
    return Boolean(value && typeof value === "object" && typeof (value as Record<string, unknown>).retcode === "number");
  }
}
