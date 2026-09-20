import type { JsonValue } from "../shared/types.js";
import { Logger } from "../shared/logger.js";

export interface OneBotClientOptions {
  websocketEndpoint: string;
  apiEndpoint: string;
  accessToken?: string;
  reconnectMs: number;
  requestTimeoutMs: number;
}

type OneBotEvent = Record<string, unknown>;

type OneBotEnvelope<T> = {
  status?: unknown;
  retcode?: unknown;
  data?: T;
  message?: unknown;
  wording?: unknown;
};

function actionUrl(endpoint: string, action: string): URL {
  if (!/^[A-Za-z0-9_]+$/.test(action)) throw new Error(`ONEBOT_ACTION_INVALID:${action}`);
  const base = endpoint.endsWith("/") ? endpoint : `${endpoint}/`;
  return new URL(action, base);
}

export class OneBotClient {
  private readonly options: OneBotClientOptions;
  private socket: WebSocket | undefined;
  private stopped = false;
  private connecting = false;
  private eventHandler: ((event: OneBotEvent) => Promise<void>) | undefined;
  private readonly log: Logger;

  constructor(options: OneBotClientOptions, logger: Logger) {
    this.options = options;
    this.log = logger.child("onebot");
  }

  async start(onEvent: (event: OneBotEvent) => Promise<void>): Promise<void> {
    this.eventHandler = onEvent;
    this.stopped = false;
    void this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const socket = this.socket;
    this.socket = undefined;
    socket?.close();
  }

  async action<T = unknown>(action: string, params: Record<string, JsonValue> = {}): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.requestTimeoutMs);
    try {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (this.options.accessToken) headers.authorization = `Bearer ${this.options.accessToken}`;
      const response = await fetch(actionUrl(this.options.apiEndpoint, action), {
        method: "POST",
        headers,
        body: JSON.stringify(params),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`ONEBOT_HTTP_${response.status}`);
      const body = await response.json() as OneBotEnvelope<T>;
      if (body.status !== "ok" || body.retcode !== 0) {
        const detail = typeof body.wording === "string" ? body.wording : typeof body.message === "string" ? body.message : String(body.retcode ?? "invalid_envelope");
        throw new Error(`ONEBOT_ACTION_FAILED:${action}:${detail}`);
      }
      return body.data as T;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async connect(): Promise<void> {
    if (this.stopped || this.connecting || this.socket) return;
    this.connecting = true;
    try {
      const url = new URL(this.options.websocketEndpoint);
      if (this.options.accessToken) url.searchParams.set("access_token", this.options.accessToken);
      const socket = new WebSocket(url);
      this.socket = socket;
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        socket.addEventListener("open", () => { settled = true; this.log.info("OneBot WebSocket connected"); resolve(); });
        socket.addEventListener("error", () => { if (!settled) reject(new Error("ONEBOT_WS_CONNECT_FAILED")); });
      });
      socket.addEventListener("message", (event) => { void this.handleMessage(String(event.data)); });
      socket.addEventListener("close", () => { this.socket = undefined; this.scheduleReconnect(); });
      socket.addEventListener("error", () => { this.log.warn("OneBot WebSocket error"); });
    } catch (error) {
      this.socket = undefined;
      this.log.error("OneBot WebSocket connection failed", { error: String(error) });
      this.scheduleReconnect();
    } finally {
      this.connecting = false;
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    setTimeout(() => { void this.connect(); }, this.options.reconnectMs).unref();
  }

  private async handleMessage(raw: string): Promise<void> {
    let value: OneBotEvent;
    try { value = JSON.parse(raw) as OneBotEvent; } catch { this.log.warn("Ignoring invalid OneBot JSON frame"); return; }
    // OneBot API responses have status/echo; only protocol events reach the adapter.
    if (typeof value.post_type !== "string") return;
    try { await this.eventHandler?.(value); } catch (error) { this.log.error("OneBot event handler failed", { error: String(error) }); }
  }
}
