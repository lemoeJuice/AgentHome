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
  private readonly podman: string;
  private readonly log: Logger;
  private child: ChildProcessWithoutNullStreams | undefined;
  private lines: Interface | undefined;
  private readonly pending = new Map<string, PendingDelivery>();
  private connected = false;
  private hello: { resolve: () => void; reject: (error: Error) => void } | undefined;

  constructor(config: AppConfig, state: GatewayState, logger: Logger, options: ControllerOptions = {}) {
    this.config = config; this.state = state;
    this.containerName = options.containerName ?? process.env.AGENT_HOME_CONTAINER ?? `agent-home-${config.instanceId}`;
    this.image = options.image ?? process.env.AGENT_HOME_IMAGE ?? "agent-home:latest";
    this.volume = options.volume ?? process.env.AGENT_HOME_VOLUME ?? `agent-home-${config.instanceId}-state`;
    this.podman = options.podmanCommand ?? process.env.PODMAN_COMMAND ?? "podman";
    this.log = logger.child("controller");
  }

  async start(): Promise<void> {
    await this.ensureContainerRunning();
    let lastError: Error | undefined;
    for (let attempt = 0; attempt < 20; attempt++) {
      try { await this.connectStream(); lastError = undefined; break; } catch (error) { lastError = error as Error; await delay(250); }
    }
    if (lastError) throw lastError;
    await this.flushOutbox();
  }

  async stop(): Promise<void> {
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

  private async flushOutbox(): Promise<void> {
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
    await this.ensureContainerRunning();
    const child = spawn(this.podman, ["exec", "-i", this.containerName, "agent-home", "control", "stream"], { stdio: ["pipe", "pipe", "pipe"] });
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
      child.stdin.write(`${JSON.stringify({ type: "hello", protocolVersion: 1, instanceId: this.config.instanceId, controllerSessionId: newId("controller") })}\n`);
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
  }

  private async ensureContainerRunning(): Promise<void> {
    try {
      const result = await execFileAsync(this.podman, ["inspect", "-f", "{{.State.Running}}", this.containerName]);
      if (result.stdout.trim() === "true") return;
      await execFileAsync(this.podman, ["start", this.containerName]);
      return;
    } catch (error) {
      if (!String(error).includes("No such object") && !String(error).includes("does not exist")) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("PODMAN_UNAVAILABLE");
        // A failed inspect is commonly a missing container. Creation below provides the actionable error otherwise.
      }
    }
    await execFileAsync(this.podman, ["volume", "exists", this.volume]).catch(async () => { await execFileAsync(this.podman, ["volume", "create", this.volume]); });
    await execFileAsync(this.podman, ["run", "-d", "--name", this.containerName, "--volume", `${this.volume}:/state:Z,U`, "--network", "slirp4netns", this.image, "runtime"]);
  }
}
