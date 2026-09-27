import { chown, chmod, lchown, lstat, mkdir, readdir, readlink, realpath, rename, symlink, unlink } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type { SqliteStore } from "../db.js";
import type { Trust } from "../shared/types.js";
import { newId, nowIso } from "../shared/ids.js";
import { proxyEnvironment } from "./network.js";

export const PRINCIPAL_UID_MIN = 20_000;
export const PRINCIPAL_UID_MAX = 60_000;
export const OWNER_PRINCIPAL_ID = "principal:owner";
export const OWNER_RUNTIME_UID = 10_001;
export const OWNER_RUNTIME_GID = 10_001;

export interface PrincipalRecord {
  principalId: string;
  runtimeUid: number;
  runtimeGid: number;
  role: Trust;
}

type PrincipalRow = { principal_id: string; trust: Trust; runtime_uid: number | null; runtime_gid: number | null };

export class PrincipalService {
  private readonly db: SqliteStore;
  private readonly stateRoot: string;

  constructor(db: SqliteStore, stateRoot: string) {
    this.db = db;
    this.stateRoot = resolve(stateRoot);
  }

  ensureOwnerPrincipal(): PrincipalRecord {
    return this.db.transaction(() => {
      const row = this.ensureRuntimeIdentity(OWNER_PRINCIPAL_ID, "OWNER");
      if (row.runtime_uid === null || row.runtime_gid === null) throw new Error("PRINCIPAL_UID_ASSIGNMENT_FAILED");
      return { principalId: row.principal_id, runtimeUid: row.runtime_uid, runtimeGid: row.runtime_gid, role: row.trust };
    });
  }

  backfillRuntimeIds(): void {
    this.db.transaction(() => {
      const rows = this.db.all<PrincipalRow>("SELECT principal_id,trust,runtime_uid,runtime_gid FROM principals ORDER BY CASE WHEN principal_id=? THEN 0 ELSE 1 END,created_at,principal_id", OWNER_PRINCIPAL_ID);
      for (const row of rows) this.ensureRuntimeIdentity(row.principal_id, row.trust);
    });
  }

  backfillTaskPrincipals(configuredOwners?: { platform: string; accountId: string; userId: string } | Array<{ platform: string; accountId: string; userId: string }>, guestTaskTimeoutMs = 30 * 60 * 1000): void {
    const rows = this.db.all<{ id: string; requester_json: string; trust: Trust }>("SELECT id,requester_json,trust FROM tasks WHERE principal_id IS NULL OR principal_id='' ");
    for (const row of rows) {
      let requester: { platform?: string; accountId?: string; userId?: string; principalId?: string; runtimeUid?: number; runtimeGid?: number };
      try { requester = JSON.parse(row.requester_json) as typeof requester; } catch { throw new Error(`TASK_REQUESTER_INVALID:${row.id}`); }
      let principalId = requester.principalId;
      if (!principalId && requester.platform && requester.accountId && requester.userId) {
        principalId = this.resolveIdentity(requester.platform, requester.accountId, requester.userId, configuredOwners).principalId;
      }
      if (!principalId) continue;
      const principal = this.get(principalId);
      requester.principalId = principalId;
      requester.runtimeUid = principal.runtimeUid;
      requester.runtimeGid = principal.runtimeGid;
      this.db.transaction(() => {
        this.db.run("UPDATE tasks SET principal_id=?,requester_json=? WHERE id=? AND (principal_id IS NULL OR principal_id='')", principalId as string, JSON.stringify(requester), row.id);
        this.db.run("UPDATE worker_executions SET principal_id=?,runtime_uid=?,runtime_gid=? WHERE task_id=? AND (principal_id IS NULL OR principal_id='')", principalId as string, principal.runtimeUid, principal.runtimeGid, row.id);
      });
    }
    const tasks = this.db.all<{ id: string; principal_id: string | null; requester_json: string; trust: Trust; created_at: string; deadline_at: string | null }>("SELECT id,principal_id,requester_json,trust,created_at,deadline_at FROM tasks");
    for (const task of tasks) {
      let principalId = task.principal_id;
      if (!principalId) {
        try { principalId = (JSON.parse(task.requester_json) as { principalId?: string }).principalId ?? null; } catch { principalId = null; }
      }
      if (!principalId) continue;
      const principal = this.get(principalId);
      const deadline = task.trust === "GUEST" ? task.deadline_at ?? new Date(Date.parse(task.created_at) + guestTaskTimeoutMs).toISOString() : task.deadline_at;
      this.db.transaction(() => {
        this.db.run("UPDATE tasks SET principal_id=?,deadline_at=COALESCE(deadline_at,?) WHERE id=?", principalId, deadline ?? null, task.id);
        const workers = this.db.all<{ id: string; workspace_id: string | null }>("SELECT id,workspace_id FROM worker_executions WHERE task_id=?", task.id);
        for (const worker of workers) {
          const workspaceId = worker.workspace_id ?? "default";
          const workspaceScope = `principal:${principalId}:${workspaceId}`;
          this.db.run("UPDATE worker_executions SET principal_id=?,runtime_uid=?,runtime_gid=?,process_mode='PRINCIPAL_BROKERED',workspace_id=COALESCE(workspace_id,'default'),workspace_access=COALESCE(workspace_access,'WRITE'),workspace_scope_id=? WHERE id=?", principalId, principal.runtimeUid, principal.runtimeGid, workspaceScope, worker.id);
        }
      });
    }
  }

  resolveIdentity(platform: string, accountId: string, externalId: string, configuredOwners?: { platform: string; accountId: string; userId: string } | Array<{ platform: string; accountId: string; userId: string }>): { principalId: string; trust: Trust } {
    const isConfiguredOwner = (configuredOwners ? (Array.isArray(configuredOwners) ? configuredOwners : [configuredOwners]) : []).some((owner) => platform === owner.platform && accountId === owner.accountId && externalId === owner.userId);
    return this.db.transaction(() => {
      if (isConfiguredOwner) {
        this.ensureRuntimeIdentity(OWNER_PRINCIPAL_ID, "OWNER");
        this.db.run("INSERT INTO platform_identities(platform,account_id,user_id,principal_id) VALUES (?,?,?,?) ON CONFLICT(platform,account_id,user_id) DO UPDATE SET principal_id=excluded.principal_id", platform, accountId, externalId, OWNER_PRINCIPAL_ID);
        return { principalId: OWNER_PRINCIPAL_ID, trust: "OWNER" as const };
      }
      const existing = this.db.get<{ principal_id: string; trust: Trust }>("SELECT p.principal_id,p.trust FROM platform_identities i JOIN principals p ON p.principal_id=i.principal_id WHERE i.platform=? AND i.account_id=? AND i.user_id=?", platform, accountId, externalId);
      if (existing) {
        this.ensureRuntimeIdentity(existing.principal_id, existing.trust);
        return { principalId: existing.principal_id, trust: existing.trust };
      }
      const principalId = newId("principal");
      this.ensureRuntimeIdentity(principalId, "GUEST");
      this.db.run("INSERT INTO platform_identities(platform,account_id,user_id,principal_id) VALUES (?,?,?,?)", platform, accountId, externalId, principalId);
      return { principalId, trust: "GUEST" as const };
    });
  }

  get(principalId: string): PrincipalRecord {
    const row = this.db.get<PrincipalRow>("SELECT principal_id,trust,runtime_uid,runtime_gid FROM principals WHERE principal_id=?", principalId);
    if (!row || row.runtime_uid === null || row.runtime_gid === null) throw new Error("PRINCIPAL_NOT_PROVISIONED");
    return { principalId: row.principal_id, runtimeUid: row.runtime_uid, runtimeGid: row.runtime_gid, role: row.trust };
  }

  async ensurePrincipalDirectories(principalId: string): Promise<{ root: string; home: string; projects: string; cache: string; artifacts: string; agent: string }> {
    this.assertSystemRoot();
    const principal = this.get(principalId);
    await this.ensureSystemDirectories();
    const principalsRoot = join(this.stateRoot, "principals");
    await mkdir(principalsRoot, { recursive: true, mode: 0o711 });
    await chown(principalsRoot, 0, 0);
    await chmod(principalsRoot, 0o711);
    const root = this.principalRoot(principalId);
    await this.ensureOwnedDirectory(root, principal.runtimeUid, principal.runtimeGid, 0o700);
    const home = join(root, "home");
    const cache = join(root, "cache");
    const artifacts = join(root, "artifacts");
    const agent = join(root, "agent");
    if (principalId === OWNER_PRINCIPAL_ID) {
      await mkdir(root, { recursive: true, mode: 0o700 });
      await this.relocateOwnerDirectory(join(this.stateRoot, "home"), home);
      await this.relocateOwnerDirectory(join(this.stateRoot, "projects"), join(root, "projects"));
      const legacyAgentLink = join(root, "agent");
      try {
        const legacyAgentInfo = await lstat(legacyAgentLink);
        if (legacyAgentInfo.isSymbolicLink()) {
          const target = await realpath(legacyAgentLink).catch(() => "");
          const allowedTargets = [resolve(this.stateRoot, "home", ".pi", "agent"), resolve(this.stateRoot, "model", "pi", "agent")];
          if (target && !allowedTargets.includes(target)) throw new Error("OWNER_AGENT_LINK_MISMATCH");
          await unlink(legacyAgentLink);
        } else if (!legacyAgentInfo.isDirectory()) throw new Error("OWNER_AGENT_DIRECTORY_INVALID");
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      await this.ensureOwnedDirectory(home, principal.runtimeUid, principal.runtimeGid, 0o700);
      await this.ensureOwnedDirectory(agent, principal.runtimeUid, principal.runtimeGid, 0o700);
      await this.ensureDirectoryLink(join(this.stateRoot, "home"), home);
      await this.ensureDirectoryLink(join(this.stateRoot, "projects"), join(root, "projects"));
    }
    for (const directory of [home, cache, artifacts, agent, join(home, ".local"), join(home, ".local", "bin"), join(home, ".local", "share"), join(home, ".local", "state"), join(home, ".local", "uv-tools"), join(home, ".config"), join(home, ".npm-global"), join(home, ".npm-global", "bin"), join(cache, "xdg"), join(cache, "npm"), join(cache, "pip"), join(cache, "uv"), join(cache, "go-build"), join(cache, "go-mod"), join(home, "go"), join(home, "tmp")]) {
      if (principalId === OWNER_PRINCIPAL_ID && (directory === home || directory === agent)) continue;
      await this.ensureOwnedDirectory(directory, principal.runtimeUid, principal.runtimeGid, 0o700);
    }
    let projects = join(root, "projects");
    projects = join(root, "projects");
    await this.ensureOwnedDirectory(projects, principal.runtimeUid, principal.runtimeGid, 0o700);
    return { root, home, projects, cache, artifacts, agent };
  }

  async ensureOwnerDirectories(): Promise<void> {
    await this.ensurePrincipalDirectories(OWNER_PRINCIPAL_ID);
  }

  private async ensureSystemDirectories(): Promise<void> {
    const ownerRow = this.db.get<{ runtime_uid: number | null; runtime_gid: number | null }>("SELECT runtime_uid,runtime_gid FROM principals WHERE principal_id=?", OWNER_PRINCIPAL_ID);
    const serviceUid = ownerRow?.runtime_uid ?? 0;
    const serviceGid = ownerRow?.runtime_gid ?? 0;
    await chown(this.stateRoot, 0, 0);
    await chmod(this.stateRoot, 0o711);
    for (const name of ["config", "secrets", "data", "inbox", "artifacts", "snowluma", "backups"]) {
      const path = join(this.stateRoot, name);
      await mkdir(path, { recursive: true, mode: 0o700 });
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`SYSTEM_DIRECTORY_INVALID:${name}`);
      if (info.uid !== 0 || info.gid !== 0) await this.chownTree(path, 0, 0);
      await chmod(path, 0o700);
    }
    for (const path of ["/tmp", "/var/tmp", "/dev/shm"]) {
      try {
        const info = await lstat(path);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`SYSTEM_TEMP_DIRECTORY_INVALID:${path}`);
        await chown(path, 0, 0);
        await chmod(path, 0o700);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    await mkdir(join(this.stateRoot, "scratch", "tmp"), { recursive: true, mode: 0o700 });
    await chown(join(this.stateRoot, "scratch"), 0, 0);
    await chmod(join(this.stateRoot, "scratch"), 0o700);
    await chown(join(this.stateRoot, "scratch", "tmp"), 0, 0);
    await chmod(join(this.stateRoot, "scratch", "tmp"), 0o700);
    const workers = join(this.stateRoot, "workers");
    await mkdir(workers, { recursive: true, mode: 0o711 });
    await chown(workers, 0, 0);
    await chmod(workers, 0o711);
    for (const name of ["sessions", "scratch", "projects", "orchestrators"]) {
      await this.ensureOwnedDirectory(join(workers, name), serviceUid, serviceGid, 0o700);
    }
    for (const name of ["sessions", "scratch"]) await this.ensureOwnedDirectory(join(this.stateRoot, name), serviceUid, serviceGid, 0o700);
  }

  async workspacePath(principalId: string, workspaceId: string): Promise<string> {
    const id = canonicalWorkspaceId(workspaceId);
    const directories = await this.ensurePrincipalDirectories(principalId);
    const candidate = resolve(directories.projects, id);
    const boundary = await realpath(directories.projects);
    await mkdir(candidate, { recursive: true, mode: 0o700 });
    const realCandidate = await realpath(candidate);
    if (!isWithin(boundary, realCandidate)) throw new Error("WORKSPACE_PATH_ESCAPE");
    const principal = this.get(principalId);
    await this.ensureOwnedDirectory(realCandidate, principal.runtimeUid, principal.runtimeGid, 0o700);
    return realCandidate;
  }

  workspacePathSync(principalId: string, workspaceId: string): string {
    return resolve(this.principalRoot(principalId), "projects", canonicalWorkspaceId(workspaceId));
  }

  guestProcessEnvironment(principalId: string, proxyUrl?: string): NodeJS.ProcessEnv {
    return this.principalProcessEnvironment(principalId, proxyUrl);
  }

  principalProcessEnvironment(principalId: string, proxyUrl?: string): NodeJS.ProcessEnv {
    const home = join(this.principalRoot(principalId), "home");
    const cache = join(this.principalRoot(principalId), "cache");
    const agent = join(this.principalRoot(principalId), "agent");
    return {
      HOME: home,
      USER: principalId === OWNER_PRINCIPAL_ID ? "agent" : "guest",
      LOGNAME: principalId === OWNER_PRINCIPAL_ID ? "agent" : "guest",
      XDG_CACHE_HOME: join(cache, "xdg"),
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local", "share"),
      XDG_STATE_HOME: join(home, ".local", "state"),
      NPM_CONFIG_CACHE: join(cache, "npm"),
      NPM_CONFIG_PREFIX: join(home, ".npm-global"),
      PYTHONUSERBASE: join(home, ".local"),
      PIP_CACHE_DIR: join(cache, "pip"),
      UV_CACHE_DIR: join(cache, "uv"),
      UV_TOOL_DIR: join(home, ".local", "uv-tools"),
      UV_TOOL_BIN_DIR: join(home, ".local", "bin"),
      GOPATH: join(home, "go"),
      GOCACHE: join(cache, "go-build"),
      GOMODCACHE: join(cache, "go-mod"),
      TMPDIR: join(home, "tmp"),
      PI_CODING_AGENT_DIR: agent,
      PATH: `${join(home, ".npm-global", "bin")}:${join(home, ".local", "bin")}:${process.env.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"}`,
      LANG: "C.UTF-8",
      ...proxyEnvironment(proxyUrl),
    };
  }

  private ensureRuntimeIdentity(principalId: string, role: Trust): PrincipalRow {
    const existing = this.db.get<PrincipalRow>("SELECT principal_id,trust,runtime_uid,runtime_gid FROM principals WHERE principal_id=?", principalId);
    if (existing && existing.runtime_uid !== null && existing.runtime_gid !== null) return existing;
    if (!existing) this.db.run("INSERT INTO principals(principal_id,trust,created_at) VALUES (?,?,?)", principalId, role, nowIso());
    const used = new Set(this.db.all<{ runtime_uid: number }>("SELECT runtime_uid FROM principals WHERE runtime_uid IS NOT NULL").map((row) => Number(row.runtime_uid)));
    let uid = existing?.runtime_uid ?? (principalId === OWNER_PRINCIPAL_ID ? OWNER_RUNTIME_UID : PRINCIPAL_UID_MIN);
    if (!existing || existing.runtime_uid === null) {
      if (principalId !== OWNER_PRINCIPAL_ID) while (uid <= PRINCIPAL_UID_MAX && used.has(uid)) uid += 1;
      else if (used.has(OWNER_RUNTIME_UID)) throw new Error("OWNER_RUNTIME_UID_CONFLICT");
    }
    if (principalId !== OWNER_PRINCIPAL_ID && uid > PRINCIPAL_UID_MAX) throw new Error("PRINCIPAL_UID_RANGE_EXHAUSTED");
    this.db.run("UPDATE principals SET trust=?,runtime_uid=?,runtime_gid=? WHERE principal_id=?", role, uid, existing?.runtime_gid ?? (principalId === OWNER_PRINCIPAL_ID ? OWNER_RUNTIME_GID : uid), principalId);
    const assigned = this.db.get<PrincipalRow>("SELECT principal_id,trust,runtime_uid,runtime_gid FROM principals WHERE principal_id=?", principalId);
    if (!assigned || assigned.runtime_uid === null || assigned.runtime_gid === null) throw new Error("PRINCIPAL_UID_ASSIGNMENT_FAILED");
    return assigned;
  }

  private principalRoot(principalId: string): string {
    if (!/^(?:principal:owner|principal_[A-Za-z0-9_-]+)$/.test(principalId)) throw new Error("PRINCIPAL_ID_INVALID");
    const root = resolve(this.stateRoot, "principals", principalId);
    if (!isWithin(resolve(this.stateRoot, "principals"), root)) throw new Error("PRINCIPAL_PATH_INVALID");
    return root;
  }

  private async relocateOwnerDirectory(legacyPath: string, targetPath: string): Promise<void> {
    let targetExists = false;
    try {
      const targetInfo = await lstat(targetPath);
      if (targetInfo.isSymbolicLink()) {
        const resolved = await realpath(targetPath).catch(() => "");
        if (resolved !== resolve(legacyPath)) throw new Error(`OWNER_DATA_MIGRATION_TARGET_MISMATCH:${targetPath}`);
        await unlink(targetPath);
      } else targetExists = true;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    let legacyInfo;
    try { legacyInfo = await lstat(legacyPath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (legacyInfo?.isSymbolicLink()) {
      const resolved = await realpath(legacyPath).catch(() => "");
      if (resolved === resolve(targetPath)) return;
      throw new Error(`OWNER_DATA_MIGRATION_LINK_MISMATCH:${legacyPath}`);
    }
    if (legacyInfo && !targetExists) {
      await rename(legacyPath, targetPath);
      return;
    }
    if (legacyInfo && targetExists) throw new Error(`OWNER_DATA_MIGRATION_COLLISION:${legacyPath}`);
    if (!targetExists) await mkdir(targetPath, { recursive: true, mode: 0o700 });
  }

  private async ensureOwnedDirectory(path: string, uid: number, gid: number, mode: number): Promise<void> {
    let exists = false;
    try {
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("PRINCIPAL_DIRECTORY_TYPE_INVALID");
      exists = true;
      if (info.uid !== uid || info.gid !== gid) await this.chownTree(path, uid, gid);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (!exists) {
      await mkdir(path, { recursive: true, mode });
      await this.chownTree(path, uid, gid);
    }
    await chmod(path, mode);
  }

  private async ensureDirectoryLink(path: string, target: string): Promise<void> {
    try {
      const info = await lstat(path);
      if (!info.isSymbolicLink() || await readlink(path) !== target) throw new Error("PRINCIPAL_DIRECTORY_LINK_MISMATCH");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await symlink(target, path, "dir");
      await lchown(path, 0, 0);
    }
  }

  private async chownTree(path: string, uid: number, gid: number): Promise<void> {
    const entries = await readdir(path, { withFileTypes: true });
    for (const entry of entries) {
      const child = join(path, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) await this.chownTree(child, uid, gid);
      else if (entry.isSymbolicLink()) await lchown(child, uid, gid);
      else await chown(child, uid, gid);
    }
    await chown(path, uid, gid);
  }

  private assertSystemRoot(): void {
    if (process.getuid?.() !== 0 || process.getgid?.() !== 0) throw new Error("PRINCIPAL_PROVISION_REQUIRES_SYSTEM_ROOT");
  }
}

export function canonicalWorkspaceId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value) || value === "." || value === "..") throw new Error("WORKSPACE_ID_INVALID");
  return value;
}

function isWithin(root: string, path: string): boolean {
  const child = relative(root, path);
  return child === "" || (child !== ".." && !child.startsWith(`..${path.includes("\\") ? "\\" : "/"}`));
}
