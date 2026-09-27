import { chown, chmod, lstat, mkdir, readFile, readdir, realpath, rename, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import type { SqliteStore } from "../db.js";

export const MODEL_RUNTIME_UID = 10_002;
export const MODEL_RUNTIME_GID = 10_002;

export interface ModelPlanePaths {
  root: string;
  home: string;
  agentDir: string;
  sessionsRoot: string;
  mainSessions: string;
  workerSessions: string;
}

export class ModelPlaneService {
  readonly paths: ModelPlanePaths;
  private readonly stateRoot: string;
  private readonly db: SqliteStore;

  constructor(db: SqliteStore, stateRoot: string, agentDir = join(stateRoot, "model", "pi", "agent")) {
    this.db = db;
    this.stateRoot = resolve(stateRoot);
    const root = join(this.stateRoot, "model");
    this.paths = {
      root,
      home: join(root, "home"),
      agentDir: resolve(agentDir),
      sessionsRoot: join(root, "sessions"),
      mainSessions: join(root, "sessions", "main"),
      workerSessions: join(root, "sessions", "workers"),
    };
    if (!isWithin(root, this.paths.agentDir)) throw new Error("MODEL_AGENT_DIR_OUTSIDE_MODEL_PLANE");
  }

  async ensure(): Promise<void> {
    const privileged = process.getuid?.() === 0 && process.getgid?.() === 0;
    const uid = privileged ? MODEL_RUNTIME_UID : process.getuid?.() ?? 0;
    const gid = privileged ? MODEL_RUNTIME_GID : process.getgid?.() ?? 0;
    await this.ensureDirectory(this.paths.root, privileged ? 0 : uid, privileged ? 0 : gid, 0o711);
    await mkdir(dirname(this.paths.agentDir), { recursive: true, mode: 0o700 });
    await this.ensureDirectory(dirname(this.paths.agentDir), uid, gid, 0o700);
    await this.migrateLegacyAgentDirectory();
    for (const path of [this.paths.home, this.paths.agentDir, this.paths.sessionsRoot, this.paths.mainSessions, this.paths.workerSessions]) {
      await this.ensureDirectory(path, uid, gid, 0o700);
    }
    await this.chownTree(this.paths.agentDir, uid, gid);
    await this.migrateSessions();
    await this.chownSessionTree(this.paths.sessionsRoot, uid, gid);
  }

  async ensureSessionDirectory(path: string): Promise<void> {
    const resolved = resolve(path);
    if (!isWithin(this.paths.sessionsRoot, resolved)) throw new Error("MODEL_SESSION_DIRECTORY_OUTSIDE_MODEL_PLANE");
    const uid = process.getuid?.() === 0 ? MODEL_RUNTIME_UID : process.getuid?.() ?? 0;
    const gid = process.getgid?.() === 0 ? MODEL_RUNTIME_GID : process.getgid?.() ?? 0;
    await this.ensureDirectory(resolved, uid, gid, 0o700);
    await this.chownSessionTree(resolved, uid, gid);
  }

  private async migrateLegacyAgentDirectory(): Promise<void> {
    const legacy = join(this.stateRoot, "home", ".pi", "agent");
    const destination = this.paths.agentDir;
    if (resolve(legacy) === destination) return;
    let sourceInfo;
    try { sourceInfo = await lstat(legacy); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    if (sourceInfo.isSymbolicLink()) {
      const target = await realpath(legacy).catch(() => "");
      if (target === destination) return;
      throw new Error("LEGACY_PI_AGENT_DIRECTORY_INVALID");
    }
    if (!sourceInfo.isDirectory()) throw new Error("LEGACY_PI_AGENT_DIRECTORY_INVALID");
    await this.validateAgentTree(legacy);
    try { await lstat(destination); throw new Error("MODEL_AGENT_MIGRATION_COLLISION"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await rename(legacy, destination);
    const uid = process.getuid?.() === 0 ? MODEL_RUNTIME_UID : process.getuid?.() ?? 0;
    const gid = process.getgid?.() === 0 ? MODEL_RUNTIME_GID : process.getgid?.() ?? 0;
    await this.chownTree(destination, uid, gid);
    await chmod(destination, 0o700);
  }

  private async migrateSessions(): Promise<void> {
    const conversations = this.db.all<{ conversation_id: string; main_session_path: string | null }>("SELECT conversation_id,main_session_path FROM conversations WHERE main_session_path IS NOT NULL");
    for (const row of conversations) {
      const destination = join(this.paths.mainSessions, safeSegment(row.conversation_id), "session.jsonl");
      if (row.main_session_path && resolve(row.main_session_path) !== resolve(destination)) {
        const moved = await moveSession(row.main_session_path, destination);
        if (!moved && !await exists(destination)) {
          this.db.run("UPDATE conversations SET main_session_id=NULL,main_session_path=NULL WHERE conversation_id=?", row.conversation_id);
          continue;
        }
        this.db.run("UPDATE conversations SET main_session_path=? WHERE conversation_id=?", destination, row.conversation_id);
      }
      await rewriteSessionWorkingDirectory(destination, dirname(destination));
    }
    const workers = this.db.all<{ id: string; harness_session_path: string | null }>("SELECT id,harness_session_path FROM worker_executions WHERE harness_session_path IS NOT NULL");
    for (const row of workers) {
      const destination = join(this.paths.workerSessions, safeWorkerSegment(row.id), "session.jsonl");
      if (row.harness_session_path && resolve(row.harness_session_path) !== resolve(destination)) {
        await moveSession(row.harness_session_path, destination);
        this.db.run("UPDATE worker_executions SET harness_session_path=? WHERE id=?", destination, row.id);
      }
      await rewriteSessionWorkingDirectory(destination, dirname(destination));
    }
  }

  private async ensureDirectory(path: string, uid: number, gid: number, mode: number): Promise<void> {
    await mkdir(path, { recursive: true, mode });
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`MODEL_DIRECTORY_INVALID:${path}`);
    if (process.getuid?.() === 0) await chown(path, uid, gid);
    await chmod(path, mode);
  }

  private async chownTree(path: string, uid: number, gid: number): Promise<void> {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) await this.chownTree(child, uid, gid);
      else {
        const info = await lstat(child);
        if (info.isSymbolicLink() || !info.isFile() || info.nlink > 1) throw new Error("MODEL_AGENT_UNSAFE_FILE_ENTRY");
        if (process.getuid?.() === 0) await chown(child, uid, gid);
      }
    }
    if (process.getuid?.() === 0) await chown(path, uid, gid);
  }

  private async chownSessionTree(path: string, uid: number, gid: number): Promise<void> {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      const info = await lstat(child);
      if (info.isSymbolicLink()) throw new Error("MODEL_SESSION_UNSAFE_FILE_ENTRY");
      if (info.isDirectory()) {
        await this.chownSessionTree(child, uid, gid);
        if (process.getuid?.() === 0) await chown(child, uid, gid);
        await chmod(child, 0o700);
      } else if (info.isFile()) {
        if (info.nlink > 1) throw new Error("MODEL_SESSION_UNSAFE_FILE_ENTRY");
        if (process.getuid?.() === 0) await chown(child, uid, gid);
        await chmod(child, 0o600);
      } else {
        throw new Error("MODEL_SESSION_UNSAFE_FILE_ENTRY");
      }
    }
    if (process.getuid?.() === 0) await chown(path, uid, gid);
    await chmod(path, 0o700);
  }

  private async validateAgentTree(path: string): Promise<void> {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      const info = await lstat(child);
      if (info.isSymbolicLink() || info.nlink > 1 || (!info.isDirectory() && !info.isFile())) throw new Error("MODEL_AGENT_UNSAFE_FILE_ENTRY");
      if (info.isDirectory()) await this.validateAgentTree(child);
    }
  }
}

async function moveSession(source: string, destination: string): Promise<boolean> {
  let sourceInfo;
  try { sourceInfo = await lstat(source); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    try {
      const destinationInfo = await lstat(destination);
      if (!destinationInfo.isFile() || destinationInfo.isSymbolicLink()) throw new Error("MODEL_SESSION_MIGRATION_TARGET_INVALID");
      if (process.getuid?.() === 0) {
        await chown(dirname(destination), MODEL_RUNTIME_UID, MODEL_RUNTIME_GID);
        await chmod(dirname(destination), 0o700);
        await chown(destination, MODEL_RUNTIME_UID, MODEL_RUNTIME_GID);
      }
      await chmod(destination, 0o600);
      return false;
    } catch (destinationError) {
      if ((destinationError as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw destinationError;
    }
  }
  if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) throw new Error("LEGACY_PI_SESSION_INVALID");
  try { await lstat(destination); throw new Error("MODEL_SESSION_MIGRATION_COLLISION"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await rename(source, destination);
  if (process.getuid?.() === 0) {
    await chown(dirname(destination), MODEL_RUNTIME_UID, MODEL_RUNTIME_GID);
    await chmod(dirname(destination), 0o700);
    await chown(destination, MODEL_RUNTIME_UID, MODEL_RUNTIME_GID);
  }
  await chmod(destination, 0o600);
  return true;
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

async function rewriteSessionWorkingDirectory(path: string, cwd: string): Promise<void> {
  let text: string;
  try { text = await readFile(path, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  const lines = text.split("\n");
  let changed = false;
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index]?.trim()) continue;
    let record: Record<string, unknown>;
    try { record = JSON.parse(lines[index]!) as Record<string, unknown>; } catch { continue; }
    if (record.type !== "session") continue;
    if (record.cwd === cwd) return;
    record.cwd = cwd;
    lines[index] = JSON.stringify(record);
    changed = true;
    break;
  }
  if (!changed) return;
  const temporary = `${path}.cwd-${process.pid}`;
  await writeFile(temporary, lines.join("\n"), { mode: 0o600 });
  if (process.getuid?.() === 0) await chown(temporary, MODEL_RUNTIME_UID, MODEL_RUNTIME_GID);
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}

function safeSegment(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeWorkerSegment(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error("WORKER_SESSION_ID_INVALID");
  return value;
}

function isWithin(root: string, path: string): boolean {
  const base = resolve(root);
  const child = resolve(path);
  return child === base || child.startsWith(`${base}/`);
}
