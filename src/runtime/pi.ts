import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { chown, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import type { Logger } from "../shared/logger.js";
import { PI_THINKING_LEVELS } from "../shared/pi-model.js";
import { proxyEnvironment } from "./network.js";
import { newId } from "../shared/ids.js";

export interface PiSession {
  sessionId: string;
  sessionPath: string;
}

export interface PiImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

/** A failed Pi turn records whether Runtime tools may already have caused side effects. */
export class PiTurnError extends Error {
  readonly toolCallsExecuted: boolean;
  constructor(message: string, toolCallsExecuted: boolean, options?: ErrorOptions) {
    super(message, options);
    this.name = "PiTurnError";
    this.toolCallsExecuted = toolCallsExecuted;
  }
}

export interface PiProcessIdentity {
  pid: number;
  processGroupId: number;
  startTime: string;
}

export type PiProcessInspection = "OWNED" | "NOT_FOUND" | "FOREIGN" | "UNKNOWN";

export interface PiSandbox {
  sessionRoot: string;
  toolSocket?: string;
  toolToken?: string;
  launcherUid?: number;
  launcherGid?: number;
  launcherCpuSeconds?: number;
  launcherMemoryBytes?: number;
  launcherPids?: number;
  launcherMaxFileBytes?: number;
}

type PiLaunchOptions = { cwd?: string; sandbox?: PiSandbox; mainTools?: boolean; extensionPath?: string };
type PiDefaults = { agentDir?: string; launcherUid?: number; launcherGid?: number };

export interface PiHarness {
  createSession(sessionPath: string, options?: PiLaunchOptions): Promise<PiSession>;
  resumeSession(session: PiSession, options?: PiLaunchOptions): Promise<boolean>;
  send(session: PiSession, prompt: string, options?: { cwd?: string; timeoutMs?: number; taskId?: string; workerId?: string; sandbox?: PiSandbox; mainTools?: boolean; extensionPath?: string; images?: PiImageContent[] }): Promise<string>;
  steer(session: PiSession, prompt: string, options?: { cwd?: string; timeoutMs?: number; images?: PiImageContent[] }): Promise<string>;
  abort(session: PiSession): Promise<boolean>;
  inspect(session: PiSession): Promise<"available" | "missing" | "unknown">;
  processId?(session: PiSession): number | undefined;
  processInfo?(session: PiSession): Promise<PiProcessIdentity | undefined>;
  inspectProcess?(session: PiSession, expected: PiProcessIdentity): Promise<PiProcessInspection>;
  terminateProcess?(session: PiSession, expected: PiProcessIdentity): Promise<boolean>;
  stop?(): Promise<void>;
}

type RpcValue = Record<string, unknown>;
type PendingRpc = { resolve: (value: RpcValue) => void; reject: (error: Error) => void };
type Turn = {
  accepted: boolean;
  settled: boolean;
  completed?: string;
  failure?: Error;
  toolCallsExecuted: boolean;
  waiters: Array<{ resolve: (output: string) => void; reject: (error: Error) => void }>;
  resolve: (output: string) => void;
  reject: (error: Error) => void;
};
type RpcProcess = {
  child: ChildProcessWithoutNullStreams;
  sessionPath: string;
  pending: Map<string, PendingRpc>;
  turn?: Turn;
  buffer: string;
  sandbox?: PiSandbox;
  mainTools: boolean;
  extensionPath?: string;
  stderrFailure?: string;
  lastRpcEventType?: string;
};

export const PI_MAX_NETWORK_RETRIES = 5;

export class PiCliHarness implements PiHarness {
  private readonly command: string;
  private readonly sandboxCommand: string;
  private readonly active = new Map<string, RpcProcess>();
  private readonly log: Logger;
  private readonly settledEvent: string;
  private readonly agentDir: string;
  private readonly launcherUid?: number;
  private readonly launcherGid?: number;
  private readonly trustedExtensionRoot: string;

  constructor(command: string, logger: Logger, sandboxCommand = process.env.AGENT_HOME_WORKER_SANDBOX ?? "bwrap", settledEvent = process.env.AGENT_HOME_PI_SETTLED_EVENT ?? "agent_settled", defaults: PiDefaults = {}) { this.command = command; this.sandboxCommand = sandboxCommand; this.settledEvent = settledEvent; this.agentDir = defaults.agentDir ?? process.env.PI_CODING_AGENT_DIR ?? join(process.env.AGENT_HOME_STATE ?? "/state", "model/pi/agent"); this.launcherUid = defaults.launcherUid; this.launcherGid = defaults.launcherGid; this.trustedExtensionRoot = dirname(fileURLToPath(import.meta.url)); this.log = logger.child("pi"); }

  async createSession(sessionPath: string, options: PiLaunchOptions = {}): Promise<PiSession> {
    await mkdir(dirname(sessionPath), { recursive: true });
    const local = { sessionId: newId("pi"), sessionPath };
    const process = await this.ensureProcess(local, options);
    const state = await this.rpc(process, { type: "get_state" });
    const realId = this.sessionIdFromState(state) ?? local.sessionId;
    this.rekey(local.sessionId, realId, process);
    return { sessionId: realId, sessionPath };
  }

  async resumeSession(session: PiSession, options: PiLaunchOptions = {}): Promise<boolean> {
    try {
      const info = await stat(session.sessionPath);
      if (!info.isFile() || info.size === 0) return false;
      const process = await this.ensureProcess(session, options);
      const state = await this.rpc(process, { type: "get_state" });
      const realId = this.sessionIdFromState(state);
      if (realId) this.rekey(session.sessionId, realId, process);
      return true;
    } catch { return false; }
  }

  async send(session: PiSession, prompt: string, options: { cwd?: string; timeoutMs?: number; taskId?: string; workerId?: string; sandbox?: PiSandbox; mainTools?: boolean; extensionPath?: string; images?: PiImageContent[] } = {}): Promise<string> {
    return this.turnWithRetries(session, { type: "prompt", message: prompt, ...(options.images?.length ? { images: options.images } : {}) }, options);
  }

  async steer(session: PiSession, prompt: string, options: { cwd?: string; timeoutMs?: number; images?: PiImageContent[] } = {}): Promise<string> {
    const process = this.findProcess(session);
    const imageFields = options.images?.length ? { images: options.images } : {};
    if (!process?.turn) return this.turnWithRetries(session, { type: "prompt", message: prompt, ...imageFields }, options);
    const turn = process.turn;
    return await new Promise<string>((resolve, reject) => {
      const waiter = { resolve, reject };
      turn.waiters.push(waiter);
      void this.rpc(process, { type: "steer", message: prompt, ...imageFields }).catch((error) => {
        const index = turn.waiters.indexOf(waiter);
        if (index >= 0) turn.waiters.splice(index, 1);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  async abort(session: PiSession): Promise<boolean> {
    const process = this.findProcess(session);
    if (!process) return true;
    this.rejectTurn(process, new Error("PI_ABORTED"));
    try { await this.rpc(process, { type: "abort" }); }
    catch (error) { this.log.warn("Pi abort RPC was not acknowledged", { sessionId: session.sessionId, error: String(error) }); }
    const identity = await this.processInfo(session);
    if (!identity || !this.terminateProcess) return false;
    const terminated = await this.terminateProcess(session, identity);
    if (!terminated) this.log.warn("Pi abort could not confirm process-group termination", { sessionId: session.sessionId, pid: identity.pid });
    return terminated;
  }

  async inspect(session: PiSession): Promise<"available" | "missing" | "unknown"> {
    try {
      const info = await stat(session.sessionPath);
      if (!info.isFile() || info.size === 0) return "missing";
    } catch { return "missing"; }
    try {
      const process = await this.ensureProcess(session);
      const state = await this.rpc(process, { type: "get_state" });
      return this.sessionIdFromState(state) ? "available" : "unknown";
    } catch { return "unknown"; }
  }

  processId(session: PiSession): number | undefined { return this.findProcess(session)?.child.pid; }

  async setDefaultModel(provider: string, modelId: string): Promise<{ activeSessionsUpdated: number; activeSessionFailures: number }> {
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(provider) || !/^[a-z0-9][a-z0-9._:/+-]*$/i.test(modelId)) throw new Error("PI_MODEL_SELECTION_INVALID");
    await mkdir(this.agentDir, { recursive: true });
    const settingsPath = join(this.agentDir, "settings.json");
    let settings: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(await readFile(settingsPath, "utf8")) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) settings = parsed as Record<string, unknown>;
    } catch { /* The first selected provider creates Pi's settings file. */ }
    settings.defaultProvider = provider;
    settings.defaultModel = modelId;
    const tempPath = `${settingsPath}.tmp-${process.pid}`;
    await writeFile(tempPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
    if (process.getuid?.() === 0 && this.launcherUid !== undefined && this.launcherGid !== undefined) await chown(tempPath, this.launcherUid, this.launcherGid);
    await rename(tempPath, settingsPath);

    let activeSessionsUpdated = 0;
    let activeSessionFailures = 0;
    for (const sessionProcess of new Set(this.active.values())) {
      try {
        await this.rpc(sessionProcess, { type: "set_model", provider, modelId });
        activeSessionsUpdated++;
      } catch (error) {
        activeSessionFailures++;
        this.log.warn("Could not hot-switch an active Pi session", { provider, model: modelId, error: String(error) });
      }
    }
    return { activeSessionsUpdated, activeSessionFailures };
  }

  async setDefaultThinkingLevel(level: string): Promise<{ activeSessionsUpdated: number; activeSessionFailures: number }> {
    if (!(PI_THINKING_LEVELS as readonly string[]).includes(level)) throw new Error("PI_THINKING_LEVEL_INVALID");
    await mkdir(this.agentDir, { recursive: true });
    const settingsPath = join(this.agentDir, "settings.json");
    let settings: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(await readFile(settingsPath, "utf8")) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) settings = parsed as Record<string, unknown>;
    } catch { /* The first selected provider creates Pi's settings file. */ }
    settings.defaultThinkingLevel = level as (typeof PI_THINKING_LEVELS)[number];
    const provider = typeof settings.defaultProvider === "string" ? settings.defaultProvider : "";
    const model = typeof settings.defaultModel === "string" ? settings.defaultModel : "";
    if (provider && model) {
      const variants = settings.modelThinkingLevels && typeof settings.modelThinkingLevels === "object" && !Array.isArray(settings.modelThinkingLevels)
        ? settings.modelThinkingLevels as Record<string, unknown>
        : {};
      variants[`${provider}/${model}`] = level;
      settings.modelThinkingLevels = variants;
    }
    const tempPath = `${settingsPath}.tmp-${process.pid}`;
    await writeFile(tempPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
    if (process.getuid?.() === 0 && this.launcherUid !== undefined && this.launcherGid !== undefined) await chown(tempPath, this.launcherUid, this.launcherGid);
    await rename(tempPath, settingsPath);

    let activeSessionsUpdated = 0;
    let activeSessionFailures = 0;
    for (const sessionProcess of new Set(this.active.values())) {
      try {
        await this.rpc(sessionProcess, { type: "set_thinking_level", level });
        activeSessionsUpdated++;
      } catch (error) {
        activeSessionFailures++;
        this.log.warn("Could not hot-switch an active Pi thinking level", { level, error: String(error) });
      }
    }
    return { activeSessionsUpdated, activeSessionFailures };
  }

  async stop(): Promise<void> {
    const processes = [...new Set(this.active.values())];
    this.active.clear();
    const exits: Promise<void>[] = [];
    for (const process of processes) {
      this.rejectTurn(process, new Error("PI_HARNESS_STOPPED"));
      const exited = new Promise<void>((resolve) => process.child.once("exit", () => resolve()));
      exits.push(Promise.race([exited, delay(1000)]).then(() => {
        process.child.stdin.destroy();
        process.child.stdout.destroy();
        process.child.stderr.destroy();
        process.child.unref();
      }));
      if (process.child.pid) {
        try { globalThis.process.kill(-process.child.pid, "SIGTERM"); } catch { process.child.kill("SIGTERM"); }
      }
    }
    await Promise.all(exits);
  }

  async processInfo(session: PiSession): Promise<PiProcessIdentity | undefined> {
    const pid = this.processId(session);
    return pid ? this.readProcessIdentity(pid) : undefined;
  }

  async inspectProcess(session: PiSession, expected: PiProcessIdentity): Promise<PiProcessInspection> {
    try {
      const current = await this.readProcessIdentity(expected.pid);
      if (!current) return "NOT_FOUND";
      if (current.startTime !== expected.startTime || current.processGroupId !== expected.processGroupId) return "FOREIGN";
      if (!current.commandLine.includes("--mode rpc") || !current.commandLine.includes(session.sessionPath)) return "FOREIGN";
      return "OWNED";
    } catch { return "UNKNOWN"; }
  }

  async terminateProcess(session: PiSession, expected: PiProcessIdentity): Promise<boolean> {
    const state = await this.inspectProcess(session, expected);
    if (state === "NOT_FOUND") return true;
    if (state !== "OWNED") return false;
    try { globalThis.process.kill(-expected.processGroupId, "SIGTERM"); } catch { return false; }
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await delay(100);
      if ((await this.inspectProcess(session, expected)) === "NOT_FOUND") return true;
    }
    try { globalThis.process.kill(-expected.processGroupId, "SIGKILL"); } catch { return false; }
    await delay(100);
    return (await this.inspectProcess(session, expected)) === "NOT_FOUND";
  }

  private async turn(session: PiSession, command: RpcValue, options: { cwd?: string; timeoutMs?: number; sandbox?: PiSandbox; mainTools?: boolean; extensionPath?: string }): Promise<string> {
    const process = await this.ensureProcess(session, options);
    if (process.turn) throw new Error("PI_SESSION_BUSY");
    const timeoutMs = options.timeoutMs ?? 60 * 60 * 1000;
    return await new Promise<string>((resolve, reject) => {
      let turn: Turn;
      const timer = setTimeout(() => {
        if (process.turn !== turn) return;
        this.rejectTurn(process, new Error("PI_TIMEOUT"));
        void this.abort(session);
      }, timeoutMs);
      turn = {
        accepted: false,
        settled: false,
        toolCallsExecuted: false,
        waiters: [],
        resolve: (output) => { clearTimeout(timer); resolve(output); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      };
      process.turn = turn;
      void this.rpc(process, command).then(() => {
        if (!process.turn) return;
        process.turn.accepted = true;
        this.completeTurn(process);
      }).catch((error) => process.turn?.reject(error instanceof Error ? error : new Error(String(error))));
    });
  }

  private async turnWithRetries(session: PiSession, command: RpcValue, options: { cwd?: string; timeoutMs?: number; sandbox?: PiSandbox; mainTools?: boolean; extensionPath?: string }): Promise<string> {
    let lastError: Error | undefined;
    for (let retry = 0; retry <= PI_MAX_NETWORK_RETRIES; retry += 1) {
      try {
        const response = await this.turn(session, command, options);
        if (response.trim()) return response;
        lastError = new Error("PI_EMPTY_RESPONSE");
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (!isRetryablePiFailure(lastError) || (lastError instanceof PiTurnError && lastError.toolCallsExecuted)) throw lastError;
      }
      if (retry === PI_MAX_NETWORK_RETRIES) break;
      this.log.warn("Retrying failed or empty Pi turn", { sessionId: session.sessionId, retry: retry + 1, maxRetries: PI_MAX_NETWORK_RETRIES, error: lastError.message });
      await delay(500 * (retry + 1));
    }
    throw lastError ?? new Error("PI_EMPTY_RESPONSE");
  }

  private async ensureProcess(session: PiSession, options: PiLaunchOptions = {}): Promise<RpcProcess> {
    const existing = this.findProcess(session);
    if (existing) {
      if (options.sandbox && (!existing.sandbox || !sameSandbox(existing.sandbox, options.sandbox))) throw new Error("PI_SANDBOX_MISMATCH");
      if (options.mainTools !== undefined && Boolean(options.mainTools) !== existing.mainTools) throw new Error("PI_TOOL_BOUNDARY_MISMATCH");
      if (options.extensionPath !== undefined && options.extensionPath !== existing.extensionPath) throw new Error("PI_EXTENSION_BOUNDARY_MISMATCH");
      return existing;
    }
    if (options.sandbox && options.extensionPath && !isWithin(this.trustedExtensionRoot, resolve(options.extensionPath))) throw new Error("PI_UNTRUSTED_EXTENSION_PATH");
    const invocation = options.sandbox ? this.sandboxInvocation(session, options.sandbox, options) : this.localInvocation(session, options);
      const launcherUid = options.sandbox?.launcherUid ?? this.launcherUid;
      const launcherGid = options.sandbox?.launcherGid ?? this.launcherGid;
      // Node 22's bundled Pi undici/llhttp WebAssembly parser needs a 128 GiB
      // virtual-address ceiling at full CLI startup; this is RLIMIT_AS, not an RSS cap.
      const principalExec = launcherUid !== undefined && launcherGid !== undefined && (launcherUid !== globalThis.process.getuid?.() || launcherGid !== globalThis.process.getgid?.());
      const command = principalExec ? globalThis.process.env.AGENT_HOME_PRINCIPAL_EXEC_COMMAND ?? globalThis.process.env.AGENT_HOME_GUEST_EXEC_COMMAND ?? "/usr/local/bin/agent-home-principal-exec" : invocation.command;
      const args = principalExec
        ? [String(launcherUid), String(launcherGid), String(launcherGid), String(options.sandbox?.launcherCpuSeconds ?? 3600), String(options.sandbox?.launcherMemoryBytes ?? 128 * 1024 * 1024 * 1024), String(options.sandbox?.launcherPids ?? 512), String(options.sandbox?.launcherMaxFileBytes ?? 2 * 1024 * 1024 * 1024), "--", invocation.command, ...invocation.args]
        : invocation.args;
      const env = principalExec ? { PATH: globalThis.process.env.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" } : invocation.env;
      const child = spawn(command, args, { cwd: invocation.cwd, env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    const process: RpcProcess = { child, sessionPath: session.sessionPath, pending: new Map(), buffer: "", mainTools: Boolean(options.mainTools), ...(options.extensionPath ? { extensionPath: options.extensionPath } : {}), ...(options.sandbox ? { sandbox: options.sandbox } : {}) };
    this.active.set(session.sessionId, process);
    child.stdout.on("data", (chunk) => this.handleOutput(process, String(chunk)));
    child.stderr.on("data", (chunk) => {
      const category = classifyPiStderr(String(chunk));
      if (category) process.stderrFailure = category;
      this.log.debug("Pi RPC stderr", { category: category ?? "unclassified", sessionId: session.sessionId });
    });
    child.stdin.on("error", (error) => this.failProcess(process, error instanceof Error ? error : new Error(String(error))));
    child.on("error", (error) => this.failProcess(process, error instanceof Error ? error : new Error(String(error))));
    child.on("exit", (code, signal) => this.failProcess(process, new Error(piExitError(process, code, signal))));
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => finish(new Error("PI_RPC_START_TIMEOUT")), 5000);
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.removeListener("error", onError);
        child.removeListener("exit", onExit);
        child.removeListener("spawn", onSpawn);
        if (error) reject(error); else resolve();
      };
      const onError = (error: Error) => finish(error);
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => finish(new Error(piExitError(process, code, signal)));
      const onSpawn = () => finish();
      child.once("error", onError);
      child.once("exit", onExit);
      child.once("spawn", onSpawn);
    });
    return process;
  }

  private localInvocation(session: PiSession, options: PiLaunchOptions): { command: string; args: string[]; cwd?: string; env: NodeJS.ProcessEnv } {
    const args: string[] = [];
    if (options.mainTools) args.push("--no-builtin-tools", "--no-extensions", "--no-skills", "--no-context-files");
    if (options.extensionPath) args.push("--extension", options.extensionPath);
    args.push("--mode", "rpc", "--session", session.sessionPath);
    const env = options.mainTools
      ? { PATH: process.env.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", HOME: "/tmp/agent-home-main", XDG_CONFIG_HOME: "/tmp/agent-home-main/.config", XDG_DATA_HOME: "/tmp/agent-home-main/.local/share", XDG_STATE_HOME: "/tmp/agent-home-main/.local/state", TMPDIR: "/tmp", PI_CODING_AGENT_DIR: this.agentDir }
      : { ...globalThis.process.env, PI_CODING_AGENT_DIR: this.agentDir };
    return { command: this.command, args, cwd: options.cwd, env };
  }

  private sandboxInvocation(session: PiSession, sandbox: PiSandbox, options: PiLaunchOptions): { command: string; args: string[]; cwd?: string; env: NodeJS.ProcessEnv } {
    const args = [
      // Pi's provider client must reach the container network. Container-level
      // networking remains isolated from the host by Podman. The outer
      // rootless container already supplies a PID namespace; nested
      // --unshare-pid cannot mount /proc in that environment.
      "--die-with-parent", "--new-session", "--unshare-ipc", "--unshare-uts",
      "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
    ];
    for (const path of ["/usr", "/bin", "/lib", "/lib64", "/etc"]) {
      if (existsSync(path)) args.push("--ro-bind", path, path);
    }
    const commandRoots = this.sandboxCommandRoots();
    const authDirectory = existsSync(this.agentDir) ? [this.agentDir] : [];
    for (const path of this.sandboxDirectories([sandbox.sessionRoot, ...authDirectory, ...commandRoots, ...(sandbox.toolSocket ? [sandbox.toolSocket] : []), ...(options.extensionPath ? [options.extensionPath] : [])])) args.push("--dir", path);
    for (const path of commandRoots) args.push("--ro-bind", path, path);
    args.push("--bind", sandbox.sessionRoot, sandbox.sessionRoot);
    if (sandbox.toolSocket) args.push("--ro-bind", sandbox.toolSocket, sandbox.toolSocket);
    // Pi refreshes native OAuth credentials in place, so this directory must
    // remain writable inside the sandbox. The container volume is still the
    // only backing store; no Host path is mounted.
    if (authDirectory.length) args.push("--bind", this.agentDir, this.agentDir);
    if (options.extensionPath) args.push("--ro-bind", options.extensionPath, options.extensionPath);
    args.push("--chdir", sandbox.sessionRoot, "--clearenv", "--setenv", "HOME", "/tmp/agent-home-model", "--setenv", "XDG_CONFIG_HOME", "/tmp/agent-home-model/.config", "--setenv", "XDG_DATA_HOME", "/tmp/agent-home-model/.local/share", "--setenv", "XDG_STATE_HOME", "/tmp/agent-home-model/.local/state", "--setenv", "TMPDIR", "/tmp", "--setenv", "PI_CODING_AGENT_DIR", this.agentDir, "--setenv", "PATH", process.env.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin");
    const proxyEnv = proxyEnvironment(process.env.HTTPS_PROXY ?? process.env.https_proxy);
    for (const [name, value] of Object.entries(proxyEnv)) if (value) args.push("--setenv", name, value);
    if (Object.keys(proxyEnv).length) args.push("--setenv", "NODE_OPTIONS", "--tls-max-v1.2");
    if (sandbox.toolSocket && sandbox.toolToken) args.push("--setenv", "AGENT_HOME_RUNTIME_TOOL_SOCKET", sandbox.toolSocket, "--setenv", "AGENT_HOME_RUNTIME_TOOL_TOKEN", sandbox.toolToken);
    if (options.mainTools) args.push("--", this.command, "--no-builtin-tools", "--no-extensions", "--no-skills", "--no-context-files", ...(options.extensionPath ? ["--extension", options.extensionPath] : []), "--mode", "rpc", "--session", session.sessionPath);
    else args.push("--", this.command, ...(options.extensionPath ? ["--extension", options.extensionPath] : []), "--mode", "rpc", "--session", session.sessionPath);
    return { command: this.sandboxCommand, args, env: {} };
  }

  private sandboxCommandRoots(): string[] {
    if (this.command.includes("/")) return [];
    const roots = new Set<string>();
    for (const directory of (process.env.PATH ?? "").split(":").filter(Boolean)) {
      if (!existsSync(join(directory, this.command))) continue;
      const root = basename(directory) === "bin" ? dirname(directory) : directory;
      if (["/usr", "/bin", "/lib", "/lib64", "/etc"].some((systemRoot) => root === systemRoot || root.startsWith(`${systemRoot}/`))) continue;
      roots.add(root);
    }
    return [...roots];
  }

  private sandboxDirectories(targets: string[]): string[] {
    const directories = new Set<string>();
    for (const target of targets) {
      let current = dirname(target);
      while (current !== "/" && current !== "/tmp") { directories.add(current); current = dirname(current); }
    }
    return [...directories].sort((a, b) => a.length - b.length);
  }

  private rpc(process: RpcProcess, command: RpcValue): Promise<RpcValue> {
    const id = newId("pi-rpc");
    return new Promise<RpcValue>((resolve, reject) => {
      process.pending.set(id, { resolve, reject });
      if (process.child.stdin.destroyed || process.child.stdin.writableEnded) {
        process.pending.delete(id);
        reject(new Error("PI_STDIN_UNAVAILABLE"));
        return;
      }
      try {
        process.child.stdin.write(`${JSON.stringify({ ...command, id })}\n`, (error) => {
          if (!error) return;
          process.pending.delete(id);
          reject(error);
        });
      } catch (error) { process.pending.delete(id); reject(error instanceof Error ? error : new Error(String(error))); }
    });
  }

  private handleOutput(process: RpcProcess, chunk: string): void {
    process.buffer += chunk;
    let index = process.buffer.indexOf("\n");
    while (index >= 0) {
      const line = process.buffer.slice(0, index).replace(/\r$/, "");
      process.buffer = process.buffer.slice(index + 1);
      index = process.buffer.indexOf("\n");
      if (!line) continue;
      let value: RpcValue;
      try { value = JSON.parse(line) as RpcValue; } catch { this.log.warn("Ignoring invalid Pi RPC frame", { line: line.slice(0, 200) }); continue; }
      if (typeof value.type === "string") process.lastRpcEventType = value.type;
      if (isFailureRpcFrame(value)) {
        const frameFailure = classifyPiStderr(JSON.stringify(value));
        if (frameFailure) process.stderrFailure = frameFailure;
      }
      const assistantDelta = value.assistantMessageEvent;
      const assistantDeltaType = assistantDelta && typeof assistantDelta === "object" ? String((assistantDelta as RpcValue).type ?? "") : "";
      const isToolCallFrame = assistantDeltaType.startsWith("toolcall_");
      if (process.turn && (value.type === "tool_execution_start" || value.type === "tool_execution_end" || isToolCallFrame)) process.turn.toolCallsExecuted = true;
      if (value.type === "response" && typeof value.id === "string") {
        const pending = process.pending.get(value.id);
        if (!pending) continue;
        process.pending.delete(value.id);
        if (value.success === false) pending.reject(new Error(`PI_RPC_${String(value.error ?? "FAILED")}`));
        else pending.resolve(value);
        continue;
      }
      this.captureAssistantText(process, value);
      if (value.type === this.settledEvent && process.turn) {
        if (process.turn.failure) {
          this.rejectTurn(process, new PiTurnError(process.turn.failure.message, process.turn.toolCallsExecuted, { cause: process.turn.failure }));
          continue;
        }
        process.turn.settled = true;
        this.completeTurn(process);
      }
    }
  }

  private completeTurn(process: RpcProcess): void {
    if (!process.turn || !process.turn.accepted || !process.turn.settled || process.turn.completed === undefined) return;
    const turn = process.turn;
    const output = turn.completed ?? "";
    process.turn = undefined;
    turn.resolve(output);
    for (const waiter of turn.waiters.splice(0)) waiter.resolve(output);
  }

  private captureAssistantText(process: RpcProcess, value: RpcValue): void {
    if (!process.turn) return;
    const messages = value.message ?? value.messages;
    const messageValues = Array.isArray(messages) ? messages : messages && typeof messages === "object" ? [messages] : [];
    if (messageValues.some((message) => message && typeof message === "object" && Array.isArray((message as RpcValue).content) && ((message as RpcValue).content as unknown[]).some((item) => item && typeof item === "object" && (item as RpcValue).type === "toolCall"))) process.turn.toolCallsExecuted = true;
    const failure = this.extractAssistantFailure(messages) ?? (value.type === "agent_error" ? rpcError(value.error) : undefined);
    if (failure) process.turn.failure = failure;
    const text = this.extractAssistantText(messages);
    if (text) process.turn.completed = text;
    if (value.type === this.settledEvent && process.turn.completed === undefined) process.turn.completed = "";
  }

  private extractAssistantFailure(messages: unknown): Error | undefined {
    const values = Array.isArray(messages) ? messages : messages && typeof messages === "object" ? [messages] : [];
    for (const message of [...values].reverse()) {
      if (!message || typeof message !== "object" || (message as RpcValue).role !== "assistant") continue;
      const value = message as RpcValue;
      const errorMessage = typeof value.errorMessage === "string" ? value.errorMessage.trim() : "";
      if (value.stopReason === "error" || errorMessage) return new Error(errorMessage || "PI_PROVIDER_ERROR");
    }
    return undefined;
  }

  private rejectTurn(process: RpcProcess, error: Error): void {
    const turn = process.turn;
    if (!turn) return;
    process.turn = undefined;
    turn.reject(error);
    for (const waiter of turn.waiters.splice(0)) waiter.reject(error);
  }

  private failProcess(process: RpcProcess, error: Error): void {
    for (const pending of process.pending.values()) pending.reject(error);
    process.pending.clear();
    const turn = process.turn;
    const failure = turn?.failure ?? error;
    this.rejectTurn(process, new PiTurnError(failure.message, turn?.toolCallsExecuted ?? false, { cause: failure }));
    for (const [id, value] of this.active) if (value === process) this.active.delete(id);
  }

  private findProcess(session: PiSession): RpcProcess | undefined {
    const direct = this.active.get(session.sessionId);
    if (direct) return direct;
    return [...this.active.values()].find((process) => process.sessionPath === session.sessionPath);
  }

  private rekey(oldId: string, newId: string, process: RpcProcess): void {
    if (oldId !== newId && this.active.get(oldId) === process) this.active.delete(oldId);
    this.active.set(newId, process);
  }

  private sessionIdFromState(value: RpcValue): string | undefined {
    const data = value.data;
    if (!data || typeof data !== "object") return undefined;
    const sessionId = (data as RpcValue).sessionId;
    return typeof sessionId === "string" && sessionId ? sessionId : undefined;
  }

  private extractAssistantText(messages: unknown): string {
    const values = Array.isArray(messages) ? messages : messages && typeof messages === "object" ? [messages] : [];
    for (const message of [...values].reverse()) {
      if (!message || typeof message !== "object" || (message as RpcValue).role !== "assistant") continue;
      const content = (message as RpcValue).content;
      if (typeof content === "string") return content;
      if (Array.isArray(content)) return content.filter((item) => item && typeof item === "object" && (item as RpcValue).type === "text").map((item) => String((item as RpcValue).text ?? "")).join("");
    }
    return "";
  }

  private async readProcessIdentity(pid: number): Promise<(PiProcessIdentity & { commandLine: string }) | undefined> {
    try {
      const statLine = await readFile(`/proc/${pid}/stat`, "utf8");
      const commandLine = (await readFile(`/proc/${pid}/cmdline`, "utf8")).replaceAll("\u0000", " ").trim();
      const close = statLine.lastIndexOf(")");
      const fields = statLine.slice(close + 2).trim().split(/\s+/);
      const processGroupId = Number(fields[2]);
      const startTime = fields[19];
      if (!Number.isInteger(processGroupId) || !startTime) return undefined;
      return { pid, processGroupId, startTime, commandLine };
    } catch { return undefined; }
  }
}

function rpcError(value: unknown): Error {
  if (value instanceof Error) return value;
  if (typeof value === "string" && value.trim()) return new Error(value);
  if (value && typeof value === "object" && "message" in value && typeof value.message === "string") return new Error(value.message);
  return new Error("PI_PROVIDER_ERROR");
}

function classifyPiStderr(value: string): string | undefined {
  const message = value.toLowerCase();
  if (["econnreset", "connection reset", "network socket disconnected", "socket hang up", "fetch failed", "etimedout", "eai_again", "enotfound", "unexpected eof"].some((marker) => message.includes(marker))) {
    if (message.includes("econnreset") || message.includes("connection reset")) return "ECONNRESET";
    if (message.includes("etimedout")) return "ETIMEDOUT";
    if (message.includes("eai_again") || message.includes("enotfound")) return "DNS_FAILURE";
    return "fetch failed";
  }
  if (["unauthorized", "invalid_grant", "authentication failed", "token expired"].some((marker) => message.includes(marker))) return "PI_PROVIDER_AUTH_FAILURE";
  if (["webassembly.instantiate", "out of memory", "wasm memory"].some((marker) => message.includes(marker))) return "PI_RUNTIME_MEMORY_FAILURE";
  return undefined;
}

function isFailureRpcFrame(value: RpcValue): boolean {
  if (value.type === "agent_error" || value.stopReason === "error" || typeof value.errorMessage === "string") return true;
  const messages = Array.isArray(value.messages) ? value.messages : value.message ? [value.message] : [];
  return messages.some((message) => message && typeof message === "object" && ((message as RpcValue).stopReason === "error" || typeof (message as RpcValue).errorMessage === "string"));
}

function piExitError(process: RpcProcess, code: number | null, signal: NodeJS.Signals | null): string {
  const detail = process.stderrFailure ?? (process.lastRpcEventType ? `LAST_RPC_EVENT:${process.lastRpcEventType}` : undefined);
  return `PI_EXIT:${code ?? signal ?? "unknown"}${detail ? `:${detail}` : ""}`;
}

function isRetryablePiFailure(error: Error): boolean {
  const message = errorMessages(error).toLowerCase();
  if (message === "pi_empty_response") return true;
  return [
    "provider_transport_failure",
    "websocket error",
    "fetch failed",
    "network socket disconnected",
    "socket hang up",
    "econnreset",
    "econnrefused",
    "etimedout",
    "eai_again",
    "enotfound",
    "dns",
    "tls",
    "unexpected eof",
  ].some((marker) => message.includes(marker));
}

export function piNetworkFailureHint(error: unknown): string | undefined {
  const message = errorMessages(error).toLowerCase();
  if (["econnreset", "connection reset", "network socket disconnected", "socket hang up", "unexpected eof"].some((marker) => message.includes(marker))) return "与模型服务的连接被重置";
  if (!message.includes("pi_timeout") && ["etimedout", "timeout", "timed out"].some((marker) => message.includes(marker))) return "连接模型服务超时";
  if (["econnrefused", "connection refused"].some((marker) => message.includes(marker))) return "模型服务拒绝了连接";
  if (["enotfound", "eai_again", "dns"].some((marker) => message.includes(marker))) return "模型服务域名解析失败";
  if (["tls", "ssl", "certificate"].some((marker) => message.includes(marker))) return "与模型服务建立 TLS 安全连接失败";
  if (["fetch failed", "provider_transport_failure", "websocket error"].some((marker) => message.includes(marker))) return "模型服务网络请求失败（fetch failed）";
  return undefined;
}

function errorMessages(error: unknown): string {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    if (current instanceof Error) {
      messages.push(current.message);
      current = current.cause;
    } else {
      messages.push(String(current));
      break;
    }
  }
  return messages.join(" ");
}

function sameSandbox(left: PiSandbox, right: PiSandbox): boolean {
  return left.sessionRoot === right.sessionRoot && left.toolSocket === right.toolSocket && left.toolToken === right.toolToken && left.launcherUid === right.launcherUid && left.launcherGid === right.launcherGid && left.launcherCpuSeconds === right.launcherCpuSeconds && left.launcherMemoryBytes === right.launcherMemoryBytes && left.launcherPids === right.launcherPids && left.launcherMaxFileBytes === right.launcherMaxFileBytes;
}

function isWithin(root: string, path: string): boolean {
  const child = relative(resolve(root), resolve(path));
  return child === "" || (child !== ".." && !child.startsWith(`..${path.includes("\\") ? "\\" : "/"}`));
}
