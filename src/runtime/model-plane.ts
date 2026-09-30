import { chown, chmod, lstat, mkdir, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

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
  constructor(stateRoot: string, agentDir = join(stateRoot, "model", "pi", "agent")) {
    const resolvedStateRoot = resolve(stateRoot);
    const root = join(resolvedStateRoot, "model");
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
    for (const path of [this.paths.home, this.paths.agentDir, this.paths.sessionsRoot, this.paths.mainSessions, this.paths.workerSessions]) {
      await this.ensureDirectory(path, uid, gid, 0o700);
    }
    await this.chownTree(this.paths.agentDir, uid, gid);
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

}

function isWithin(root: string, path: string): boolean {
  const base = resolve(root);
  const child = resolve(path);
  return child === base || child.startsWith(`${base}/`);
}
