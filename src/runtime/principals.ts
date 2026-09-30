import { chown, chmod, lchown, lstat, mkdir, readdir, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
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
export const OWNER_WORKSPACE_UID_MIN = 10_003;
export const OWNER_WORKSPACE_UID_MAX = 19_999;
export const WORKSPACE_RUNTIME_UID_MIN = 60_001;
export const WORKSPACE_RUNTIME_UID_MAX = 65_535;

export interface PrincipalRecord {
  principalId: string;
  runtimeUid: number;
  runtimeGid: number;
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
      return { principalId: row.principal_id, runtimeUid: row.runtime_uid, runtimeGid: row.runtime_gid };
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
    const tasks = this.db.all<{ id: string; principal_id: string | null; requester_json: string; trust: Trust; created_at: string; deadline_at: string | null; origin_conversation_id: string }>("SELECT id,principal_id,requester_json,trust,created_at,deadline_at,origin_conversation_id FROM tasks");
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
          const workspaceScope = `conversation:${task.origin_conversation_id}:${workspaceId}`;
          this.db.run("UPDATE worker_executions SET principal_id=?,process_mode='PRINCIPAL_BROKERED',workspace_id=COALESCE(workspace_id,'default'),workspace_access=COALESCE(workspace_access,'WRITE'),workspace_scope_id=? WHERE id=?", principalId, workspaceScope, worker.id);
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
    return { principalId: row.principal_id, runtimeUid: row.runtime_uid, runtimeGid: row.runtime_gid };
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
    for (const directory of [home, cache, artifacts, agent, join(home, ".agent"), this.principalMemoryPath(principalId), join(home, ".local"), join(home, ".local", "bin"), join(home, ".local", "share"), join(home, ".local", "state"), join(home, ".local", "uv-tools"), join(home, ".config"), join(home, ".npm-global"), join(home, ".npm-global", "bin"), join(cache, "xdg"), join(cache, "npm"), join(cache, "pip"), join(cache, "uv"), join(cache, "go-build"), join(cache, "go-mod"), join(home, "go"), join(home, "tmp")]) {
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

  principalMemoryPath(principalId: string): string {
    return join(this.principalRoot(principalId), "home", ".agent", "memory");
  }

  async ensureConversationWorkspace(conversationId: string): Promise<{ root: string; home: string; projects: string; cache: string; uid: number; gid: number }> {
    if (!conversationId || conversationId.length > 512) throw new Error("CONVERSATION_WORKSPACE_ID_INVALID");
    this.assertSystemRoot();
    const { uid, gid } = this.db.transaction(() => {
      const conversation = this.db.get<{ conversation_id: string }>("SELECT conversation_id FROM conversations WHERE conversation_id=?", conversationId);
      if (!conversation) throw new Error("CONVERSATION_WORKSPACE_NOT_FOUND");
      const row = this.db.get<{ runtime_uid: number; runtime_gid: number }>("SELECT runtime_uid,runtime_gid FROM conversation_workspaces WHERE conversation_id=?", conversationId);
      const used = new Set(this.db.all<{ runtime_uid: number }>("SELECT runtime_uid FROM conversation_workspaces").map((item) => Number(item.runtime_uid)));
      const minUid = WORKSPACE_RUNTIME_UID_MIN;
      const maxUid = WORKSPACE_RUNTIME_UID_MAX;
      if (row && row.runtime_uid >= minUid && row.runtime_uid <= maxUid) return { uid: row.runtime_uid, gid: row.runtime_gid };
      if (row) used.delete(row.runtime_uid);
      let uid = minUid;
      while (uid <= maxUid && used.has(uid)) uid++;
      if (uid > maxUid) throw new Error("CONVERSATION_WORKSPACE_UID_RANGE_EXHAUSTED");
      if (row) this.db.run("UPDATE conversation_workspaces SET runtime_uid=?,runtime_gid=? WHERE conversation_id=?", uid, uid, conversationId);
      else this.db.run("INSERT INTO conversation_workspaces(conversation_id,runtime_uid,runtime_gid,created_at) VALUES (?,?,?,?)", conversationId, uid, uid, nowIso());
      return { uid, gid: uid };
    });
    const key = createHash("sha256").update(conversationId).digest("hex");
    const root = join(this.stateRoot, "workspaces", "conversations", key);
    await mkdir(join(this.stateRoot, "workspaces", "conversations"), { recursive: true, mode: 0o711 });
    await chown(join(this.stateRoot, "workspaces"), 0, 0);
    await chmod(join(this.stateRoot, "workspaces"), 0o711);
    await chown(join(this.stateRoot, "workspaces", "conversations"), 0, 0);
    await chmod(join(this.stateRoot, "workspaces", "conversations"), 0o711);
    await mkdir(root, { recursive: true, mode: 0o711 });
    await chown(root, 0, gid);
    await chmod(root, 0o711);
    const home = join(root, "home");
    const projects = join(root, "projects");
    const cache = join(root, "cache");
    await this.ensureOwnedDirectory(home, uid, gid, 0o700);
    await this.ensureOwnedDirectory(cache, uid, gid, 0o700);
    await mkdir(projects, { recursive: true, mode: 0o711 });
    await chown(projects, 0, gid);
    await chmod(projects, 0o711);
    return { root, home, projects, cache, uid, gid };
  }

  async conversationWorkspaceProcessEnvironment(conversationId: string, proxyUrl?: string): Promise<NodeJS.ProcessEnv> {
    const dirs = await this.ensureConversationWorkspace(conversationId);
    return {
      HOME: dirs.home,
      USER: "conversation",
      LOGNAME: "conversation",
      XDG_CACHE_HOME: join(dirs.cache, "xdg"),
      XDG_CONFIG_HOME: join(dirs.home, ".config"),
      XDG_DATA_HOME: join(dirs.home, ".local", "share"),
      XDG_STATE_HOME: join(dirs.home, ".local", "state"),
      NPM_CONFIG_CACHE: join(dirs.cache, "npm"),
      NPM_CONFIG_PREFIX: join(dirs.home, ".npm-global"),
      PYTHONUSERBASE: join(dirs.home, ".local"),
      PIP_CACHE_DIR: join(dirs.cache, "pip"),
      UV_CACHE_DIR: join(dirs.cache, "uv"),
      UV_TOOL_DIR: join(dirs.home, ".local", "uv-tools"),
      UV_TOOL_BIN_DIR: join(dirs.home, ".local", "bin"),
      GOPATH: join(dirs.home, "go"),
      GOCACHE: join(dirs.cache, "go-build"),
      GOMODCACHE: join(dirs.cache, "go-mod"),
      TMPDIR: join(dirs.home, "tmp"),
      PATH: `${join(dirs.home, ".npm-global", "bin")}:${join(dirs.home, ".local", "bin")}:${process.env.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"}`,
      LANG: "C.UTF-8",
      ...proxyEnvironment(proxyUrl),
    };
  }

  conversationWorkspacePath(conversationId: string, workspaceId: string): string {
    const key = createHash("sha256").update(conversationId).digest("hex");
    return resolve(this.stateRoot, "workspaces", "conversations", key, "projects", canonicalWorkspaceId(workspaceId));
  }

  async ensureConversationWorkspacePath(conversationId: string, workspaceId: string): Promise<string> {
    const dirs = await this.ensureConversationWorkspace(conversationId);
    const candidate = resolve(dirs.projects, canonicalWorkspaceId(workspaceId));
    await mkdir(candidate, { recursive: true, mode: 0o2770 });
    const realCandidate = await realpath(candidate);
    if (!isWithin(await realpath(dirs.projects), realCandidate)) throw new Error("WORKSPACE_PATH_ESCAPE");
    const existing = await lstat(realCandidate);
    if (existing.uid !== 0 || existing.gid !== dirs.gid) await this.chownTree(realCandidate, 0, dirs.gid);
    await this.setSharedWorkspaceModes(realCandidate);
    return realCandidate;
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
    const principal = this.get(principalId);
    const root = resolve(this.stateRoot, "principals", `uid-${principal.runtimeUid}`);
    if (!isWithin(resolve(this.stateRoot, "principals"), root)) throw new Error("PRINCIPAL_PATH_INVALID");
    return root;
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

  private async setSharedWorkspaceModes(path: string): Promise<void> {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) return;
    await chmod(path, 0o2770);
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) await this.setSharedWorkspaceModes(child);
      else if (!entry.isSymbolicLink()) await chmod(child, ((await lstat(child)).mode & 0o777) | 0o660);
    }
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
