import { spawn, type ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Logger } from "../shared/logger.js";
import { newId } from "../shared/ids.js";

export interface PiSession {
  sessionId: string;
  sessionPath: string;
}

export interface PiHarness {
  createSession(sessionPath: string): Promise<PiSession>;
  resumeSession(session: PiSession): Promise<boolean>;
  send(session: PiSession, prompt: string, options?: { cwd?: string; timeoutMs?: number; taskId?: string; workerId?: string }): Promise<string>;
  steer(session: PiSession, prompt: string, options?: { cwd?: string; timeoutMs?: number }): Promise<string>;
  abort(session: PiSession): Promise<boolean>;
  inspect(session: PiSession): Promise<"available" | "missing" | "unknown">;
}

export class PiCliHarness implements PiHarness {
  private readonly command: string;
  private readonly active = new Map<string, ChildProcess>();
  private readonly log: Logger;

  constructor(command: string, logger: Logger) { this.command = command; this.log = logger.child("pi"); }

  async createSession(sessionPath: string): Promise<PiSession> {
    await mkdir(dirname(sessionPath), { recursive: true });
    return { sessionId: newId("pi"), sessionPath };
  }

  async resumeSession(session: PiSession): Promise<boolean> {
    try { await import("node:fs/promises").then((fs) => fs.access(session.sessionPath)); return true; } catch { return false; }
  }

  async send(session: PiSession, prompt: string, options: { cwd?: string; timeoutMs?: number; taskId?: string; workerId?: string } = {}): Promise<string> {
    return this.run(session, prompt, options);
  }

  async steer(session: PiSession, prompt: string, options: { cwd?: string; timeoutMs?: number } = {}): Promise<string> {
    // Pi's print mode is one turn per process. The durable session file preserves context;
    // steering is therefore the next real prompt in the same Pi session.
    return this.run(session, prompt, options);
  }

  async abort(session: PiSession): Promise<boolean> {
    const child = this.active.get(session.sessionId);
    if (!child?.pid) return true;
    try {
      process.kill(-child.pid, "SIGTERM");
      await delay(500);
      if (this.active.has(session.sessionId)) process.kill(-child.pid, "SIGKILL");
      return true;
    } catch (error) {
      this.log.warn("Pi abort could not confirm process termination", { sessionId: session.sessionId, error: String(error) });
      return false;
    }
  }

  async inspect(session: PiSession): Promise<"available" | "missing" | "unknown"> {
    return (await this.resumeSession(session)) ? "available" : "missing";
  }

  private async run(session: PiSession, prompt: string, options: { cwd?: string; timeoutMs?: number; taskId?: string; workerId?: string }): Promise<string> {
    const args = ["--print", "--session", session.sessionPath, prompt];
    const child = spawn(this.command, args, { cwd: options.cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    this.active.set(session.sessionId, child);
    const timeoutMs = options.timeoutMs ?? 60 * 60 * 1000;
    return await new Promise<string>((resolve, reject) => {
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      const timer = setTimeout(() => {
        void this.abort(session);
        reject(new Error("PI_TIMEOUT"));
      }, timeoutMs);
      child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
      child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
      child.on("error", (error) => { clearTimeout(timer); this.active.delete(session.sessionId); reject((error as NodeJS.ErrnoException).code === "ENOENT" ? new Error("PI_UNAVAILABLE") : error); });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        this.active.delete(session.sessionId);
        const output = Buffer.concat(stdout).toString("utf8").trim();
        if (code === 0) resolve(output);
        else reject(new Error(`PI_EXIT:${code ?? signal ?? "unknown"}:${Buffer.concat(stderr).toString("utf8").slice(-1000)}`));
      });
    });
  }
}
