import { chmod, chown, unlink } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import type { CapabilitySet, ConversationAddress, JsonValue, PlatformMessageRef, TaskRequester, Trust } from "../shared/types.js";

export interface RuntimeToolContext {
  conversationId: string;
  requesterId: string;
  requester: TaskRequester;
  trust: Trust;
  address: ConversationAddress;
  capabilities: CapabilitySet;
  eventId?: string;
  message?: PlatformMessageRef;
  replyTo?: PlatformMessageRef;
  taskId?: string;
  workerId?: string;
  executionContextId?: string;
}

export type RuntimeToolHandler = (action: string, input: JsonValue, context: RuntimeToolContext) => Promise<JsonValue>;

type ContextResolver = (token: string) => RuntimeToolContext | undefined;

export class RuntimeToolServer {
  private readonly socketPath: string;
  private readonly resolveContext: ContextResolver;
  private readonly handler: RuntimeToolHandler;
  private readonly socketGroupId?: number;
  private server: Server | undefined;

  constructor(socketPath: string, resolveContext: ContextResolver, handler: RuntimeToolHandler, options: { socketGroupId?: number } = {}) {
    this.socketPath = socketPath;
    this.resolveContext = resolveContext;
    this.handler = handler;
    this.socketGroupId = options.socketGroupId;
  }

  async start(): Promise<void> {
    try { await unlink(this.socketPath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    this.server = createServer((socket) => this.handle(socket));
    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(this.socketPath, resolve);
    });
    if (this.socketGroupId !== undefined) {
      await chown(this.socketPath, 0, this.socketGroupId);
      await chmod(this.socketPath, 0o660);
    } else await chmod(this.socketPath, 0o600);
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()) ?? resolve());
    this.server = undefined;
    try { await unlink(this.socketPath); } catch { /* already absent */ }
  }

  private handle(socket: Socket): void {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.length > 1_000_000) {
        writeResult(socket, { ok: false, error: "TOOL_REQUEST_TOO_LARGE" });
        socket.destroy();
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      buffer = "";
      void this.dispatch(line, socket);
    });
  }

  private async dispatch(line: string, socket: Socket): Promise<void> {
    try {
      const value = JSON.parse(line) as Record<string, unknown>;
      const token = typeof value.token === "string" ? value.token : "";
      const action = typeof value.action === "string" ? value.action : "";
      if (!token || !action) throw new Error("TOOL_REQUEST_INVALID");
      const context = this.resolveContext(token);
      if (!context) throw new Error("TOOL_UNAUTHORIZED");
      const input = (value.input ?? {}) as JsonValue;
      const result = await this.handler(action, input, context);
      writeResult(socket, { ok: true, result });
    } catch (error) {
      const message = String(error instanceof Error ? error.message : error);
      const decision = error && typeof error === "object" && "decision" in error ? (error as { decision?: unknown }).decision : undefined;
      writeResult(socket, { ok: false, error: message, ...(decision ? { decision: decision as JsonValue } : {}) });
    }
  }
}

function writeResult(socket: Socket, value: JsonValue | Record<string, unknown>): void {
  if (!socket.destroyed) socket.end(`${JSON.stringify(value)}\n`);
}
