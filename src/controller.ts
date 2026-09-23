import { readFileSync } from "node:fs";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import type { AppConfig } from "./config.js";
import { GatewayState } from "./gateway/state.js";
import type { AgentEventController } from "./gateway/router.js";
import { newId, nowIso } from "./shared/ids.js";
import type { ControlAck, ControllerEventEnvelope } from "./shared/types.js";
import type { Logger } from "./shared/logger.js";

const execFileAsync = promisify(execFile);

interface PendingDelivery {
  event: ControllerEventEnvelope;
  resolve: () => void;
  reject: (error: Error) => void;
}

export interface ControllerOptions {
  containerName?: string;
  image?: string;
  volume?: string;
  podmanCommand?: string;
}

export class PodmanController implements AgentEventController {
  private readonly config: AppConfig;
  private readonly state: GatewayState;
  private readonly containerName: string;
  private readonly image: string;
  private readonly volume: string;
  private readonly network: string;
  private readonly controlToken: string | undefined;
  private readonly podman: string;
  private readonly log: Logger;
  private child: ChildProcessWithoutNullStreams | undefined;
  private lines: Interface | undefined;
  private readonly pending = new Map<string, PendingDelivery>();
  private connected = false;
  private stopping = false;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private flushing: Promise<void> | undefined;
  private connecting: Promise<void> | undefined;
  private hello: { resolve: () => void; reject: (error: Error) => void } | undefined;

  constructor(config: AppConfig, state: GatewayState, logger: Logger, options: ControllerOptions = {}) {
    this.config = config; this.state = state;
    this.containerName = options.containerName ?? process.env.AGENT_HOME_CONTAINER ?? `agent-home-${config.instanceId}`;
    this.image = options.image ?? process.env.AGENT_HOME_IMAGE ?? "agent-home:latest";
    this.volume = options.volume ?? process.env.AGENT_HOME_VOLUME ?? `agent-home-${config.instanceId}-state`;
    this.network = process.env.AGENT_HOME_NETWORK ?? "agent-home-net";
    this.controlToken = process.env.AGENT_HOME_CONTROL_TOKEN ?? (() => { try { return readFileSync(".agent-home/control-token", "utf8").trim() || undefined; } catch { return undefined; } })();
    this.podman = options.podmanCommand ?? process.env.PODMAN_COMMAND ?? "podman";
    this.log = logger.child("controller");
  }

  async start(): Promise<void> {
    this.stopping = false;
    await this.ensureContainerRunning();
    let lastError: Error | undefined;
    for (let attempt = 0; attempt < 20; attempt++) {
      try { await this.connectStream(); lastError = undefined; break; } catch (error) { lastError = error as Error; await delay(250); }
    }
    if (lastError) throw lastError;
    await this.flushOutbox();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.connected = false;
    this.lines?.close();
    this.lines = undefined;
    this.child?.kill();
    this.child = undefined;
  }

  async deliver(event: ControllerEventEnvelope): Promise<void> {
    this.state.store.run("INSERT OR IGNORE INTO controller_outbox(event_id,envelope_json,status,attempts,created_at,updated_at) VALUES (?,?,?,?,?,?)", event.eventId, JSON.stringify(event), "PENDING", 0, nowIso(), nowIso());
    await this.flushOutbox();
    if (this.state.store.get("SELECT 1 AS found FROM controller_outbox WHERE event_id=?", event.eventId)) throw new Error("CONTROL_STREAM_UNAVAILABLE");
  }

  async status(): Promise<{ container: boolean; stream: boolean }> {
    let container = false;
    try {
      const result = await execFileAsync(this.podman, ["inspect", "-f", "{{.State.Running}}", this.containerName]);
      container = result.stdout.trim() === "true";
    } catch { container = false; }
    return { container, stream: this.connected };
  }

  async health(): Promise<{ container: boolean; stream: boolean; supervisor: boolean; runtime: boolean }> {
    const status = await this.status();
    if (!status.container) return { ...status, supervisor: false, runtime: false };
    let supervisor = false;
    try { await execFileAsync(this.podman, ["exec", this.containerName, "test", "-s", process.env.AGENT_HOME_SUPERVISOR_PID ?? "/run/agent-home/supervisor.pid"]); supervisor = true; } catch { supervisor = false; }
    let runtime = false;
    try {
      await execFileAsync(this.podman, ["exec", this.containerName, "agent-home", "control", "ping"]);
      runtime = true;
    } catch { runtime = false; }
    return { ...status, supervisor, runtime };
  }

  private async flushOutbox(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = this.flushOutboxInternal();
    try { await this.flushing; } finally { this.flushing = undefined; }
  }

  private async flushOutboxInternal(): Promise<void> {
    if (!this.connected) await this.connectStream();
    const rows = this.state.store.all<{ event_id: string; envelope_json: string }>("SELECT event_id,envelope_json FROM controller_outbox WHERE status='PENDING' ORDER BY created_at LIMIT ?", this.config.runtime.maxInFlight);
    for (const row of rows) {
      if (!this.connected || this.pending.size >= this.config.runtime.maxInFlight) break;
      const event = JSON.parse(row.envelope_json) as ControllerEventEnvelope;
      this.state.store.run("UPDATE controller_outbox SET status='SENT',attempts=attempts+1,updated_at=? WHERE event_id=?", nowIso(), row.event_id);
      await new Promise<void>((resolve, reject) => {
        let timer: NodeJS.Timeout | undefined;
        this.pending.set(row.event_id, { event, resolve, reject });
        timer = setTimeout(() => { this.pending.delete(row.event_id); reject(new Error("CONTROL_ACK_TIMEOUT")); }, 15000);
        try { this.child?.stdin.write(`${JSON.stringify(event)}\n`); } catch (error) { this.pending.delete(row.event_id); clearTimeout(timer); reject(error as Error); }
        const pending = this.pending.get(row.event_id);
        if (pending) {
          const resolveOnce = pending.resolve;
          const rejectOnce = pending.reject;
          pending.resolve = () => { clearTimeout(timer); resolveOnce(); };
          pending.reject = (error) => { clearTimeout(timer); rejectOnce(error); };
        }
      }).catch((error) => {
        this.state.store.run("UPDATE controller_outbox SET status='PENDING',last_error=?,updated_at=? WHERE event_id=?", String(error), nowIso(), row.event_id);
        throw error;
      });
    }
  }

  private async connectStream(): Promise<void> {
    if (this.connected) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.connectStreamInternal();
    try { await this.connecting; } finally { this.connecting = undefined; }
  }

  private async connectStreamInternal(): Promise<void> {
    await this.ensureContainerRunning();
    const execArgs = ["exec", "-i"];
    execArgs.push(this.containerName, "agent-home", "control", "stream");
    const child = spawn(this.podman, execArgs, { stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    this.lines = createInterface({ input: child.stdout });
    this.connected = true;
    this.lines.on("line", (line) => this.handleAck(line));
    child.stderr.on("data", (chunk) => this.log.debug("control stream stderr", { output: String(chunk).trim() }));
    child.on("error", (error) => this.disconnect(error));
    child.on("exit", (code, signal) => this.disconnect(new Error(`CONTROL_STREAM_EXIT:${code ?? signal ?? "unknown"}`)));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { this.hello = undefined; reject(new Error("CONTROL_STREAM_HELLO_TIMEOUT")); this.disconnect(new Error("CONTROL_STREAM_HELLO_TIMEOUT")); }, 5000);
      this.hello = { resolve: () => { clearTimeout(timer); this.hello = undefined; resolve(); }, reject: (error) => { clearTimeout(timer); this.hello = undefined; reject(error); } };
      child.stdin.write(`${JSON.stringify({ type: "hello", protocolVersion: 1, instanceId: this.config.instanceId, controllerSessionId: newId("controller"), ...(this.controlToken ? { controlToken: this.controlToken } : {}) })}\n`);
    });
  }

  private handleAck(line: string): void {
    let value: ControlAck | { type?: string };
    try { value = JSON.parse(line) as ControlAck | { type?: string }; } catch { return; }
    if ("type" in value && value.type === "hello_ack") { this.hello?.resolve(); return; }
    if (!("eventId" in value) || typeof value.eventId !== "string") return;
    const pending = this.pending.get(value.eventId);
    if (!pending) return;
    this.pending.delete(value.eventId);
    if (value.status === "accepted" || value.status === "duplicate") {
      this.state.store.run("DELETE FROM controller_outbox WHERE event_id=?", value.eventId);
      pending.resolve();
    } else {
      this.state.store.run("UPDATE controller_outbox SET status='PENDING',last_error=?,updated_at=? WHERE event_id=?", value.errorCode ?? value.status, nowIso(), value.eventId);
      pending.reject(new Error(`CONTROL_EVENT_${value.status}:${value.errorCode ?? "unknown"}`));
    }
  }

  private disconnect(error: Error): void {
    if (!this.connected) return;
    this.hello?.reject(error);
    this.hello = undefined;
    this.connected = false;
    this.lines?.close();
    this.lines = undefined;
    this.child = undefined;
    for (const [eventId, pending] of this.pending) {
      this.state.store.run("UPDATE controller_outbox SET status='PENDING',last_error=?,updated_at=? WHERE event_id=?", error.message, nowIso(), eventId);
      pending.reject(error);
    }
    this.pending.clear();
    this.log.warn("Control stream disconnected", { error: error.message });
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopping || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.flushOutbox().catch((error) => {
        this.log.warn("Control stream reconnect failed", { error: String(error) });
        this.scheduleReconnect();
      });
    }, Math.max(100, this.config.snowluma.reconnectMs));
    this.reconnectTimer.unref();
  }

  private async ensureContainerRunning(): Promise<void> {
    try {
      const result = await execFileAsync(this.podman, ["inspect", "-f", "{{.State.Running}}", this.containerName]);
      await this.validateContainerTopology();
      if (result.stdout.trim() === "true") { await this.ensureRuntimeProcess(); return; }
      await execFileAsync(this.podman, ["start", this.containerName]);
      await this.ensureRuntimeProcess();
      return;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("CONTAINER_")) throw error;
      if (!String(error).includes("No such object") && !String(error).includes("does not exist")) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("PODMAN_UNAVAILABLE");
        // A failed inspect is commonly a missing container. Creation below provides the actionable error otherwise.
      }
    }
    await execFileAsync(this.podman, ["network", "exists", this.network]).catch(async () => { await execFileAsync(this.podman, ["network", "create", this.network]); });
    await execFileAsync(this.podman, ["volume", "exists", this.volume]).catch(async () => { await execFileAsync(this.podman, ["volume", "create", this.volume]); });
    await execFileAsync(this.podman, ["run", "-d", "--name", this.containerName, "--volume", `${this.volume}:/state:Z,U`, "--network", this.network, this.image, "supervise"]);
  }

  private async validateContainerTopology(): Promise<void> {
    const result = await execFileAsync(this.podman, ["inspect", "-f", "{{json .}}", this.containerName]);
    let inspected: { HostConfig?: { Privileged?: boolean; PidMode?: string; NetworkMode?: string; Binds?: string[]; PortBindings?: Record<string, unknown> | null }; Mounts?: Array<{ Type?: string; Name?: string; Source?: string; Destination?: string }>; NetworkSettings?: { Ports?: Record<string, unknown> | null; Networks?: Record<string, unknown> } };
    try { inspected = JSON.parse(result.stdout) as typeof inspected; }
    catch { throw new Error("CONTAINER_TOPOLOGY_INSPECT_INVALID"); }
    const hostConfig = inspected.HostConfig ?? {};
    if (hostConfig.Privileged === true) throw new Error("CONTAINER_PRIVILEGED_FORBIDDEN");
    if (hostConfig.PidMode === "host") throw new Error("CONTAINER_HOST_PID_FORBIDDEN");
    if (hostConfig.NetworkMode === "host") throw new Error("CONTAINER_HOST_NETWORK_FORBIDDEN");
    const mounts = inspected.Mounts ?? [];
    const unsafeBinds = (hostConfig.Binds ?? []).some((bind) => {
      const [source, destination] = bind.split(":", 2);
      return source !== this.volume || destination !== "/state";
    });
    if (unsafeBinds || mounts.length !== 1 || mounts[0]?.Type !== "volume" || mounts[0]?.Destination !== "/state") throw new Error("CONTAINER_MOUNT_TOPOLOGY_FORBIDDEN");
    if (mounts[0]?.Name !== this.volume && mounts[0]?.Source !== this.volume) throw new Error("CONTAINER_STATE_VOLUME_MISMATCH");
    const networkNames = Object.keys(inspected.NetworkSettings?.Networks ?? {});
    if (networkNames.length !== 1 || networkNames[0] !== this.network) throw new Error("CONTAINER_NETWORK_TOPOLOGY_FORBIDDEN");
    const hasEntries = (value: Record<string, unknown> | null | undefined): boolean => Boolean(value && Object.keys(value).length > 0);
    if (hasEntries(hostConfig.PortBindings) || hasEntries(inspected.NetworkSettings?.Ports)) throw new Error("CONTAINER_PUBLISHED_PORT_FORBIDDEN");
    for (const mount of mounts) {
      if (mount.Type === "bind") throw new Error("CONTAINER_BIND_MOUNT_FORBIDDEN");
      if (mount.Source === "/var/run/podman.sock" || mount.Source === "/run/podman/podman.sock" || mount.Source === "/var/run/docker.sock" || mount.Destination === "/var/run/podman.sock" || mount.Destination === "/run/podman/podman.sock" || mount.Destination === "/var/run/docker.sock") throw new Error("CONTAINER_SOCKET_MOUNT_FORBIDDEN");
    }
  }

  private async ensureRuntimeProcess(): Promise<void> {
    try {
      await execFileAsync(this.podman, ["exec", this.containerName, "agent-home", "control", "ping"]);
      return;
    } catch { /* Runtime may still be starting or an older container may not have a supervisor. */ }
    try {
      await execFileAsync(this.podman, ["exec", this.containerName, "test", "-s", "/run/agent-home/supervisor.pid"]);
    } catch {
      await execFileAsync(this.podman, ["exec", "-d", this.containerName, "agent-home", "supervise"]);
    }
  }
}
