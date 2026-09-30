import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { OWNER_PRINCIPAL_ID, type PrincipalService } from "../src/runtime/principals.js";

export function createTaskTestPrincipals(root: string): PrincipalService {
  const keys = new Map<string, string>();
  const roots = new Map<string, string>();
  const identity = (principalId: string) => {
    const hash = Number.parseInt(createHash("sha256").update(principalId).digest("hex").slice(0, 8), 16);
    return { principalId, runtimeUid: principalId === OWNER_PRINCIPAL_ID ? 10_001 : 20_000 + hash % 40_001, runtimeGid: principalId === OWNER_PRINCIPAL_ID ? 10_001 : 20_000 + hash % 40_001 };
  };
  const principalRoot = (principalId: string) => {
    let path = roots.get(principalId);
    if (!path) { path = join(root, "test-principals", `uid-${identity(principalId).runtimeUid}`); roots.set(principalId, path); }
    return path;
  };
  const workspaceRoot = (conversationId: string) => join(root, "test-workspaces", createHash("sha256").update(conversationId).digest("hex"));
  const ensureDir = async (path: string) => { await mkdir(path, { recursive: true, mode: 0o700 }); return path; };
  return {
    resolveIdentity(platform, accountId, userId, owners = []) {
      const key = `${platform}\0${accountId}\0${userId}`;
      let principalId = keys.get(key);
      if (!principalId) {
        const owner = (Array.isArray(owners) ? owners : [owners]).some((item) => item.platform === platform && item.accountId === accountId && item.userId === userId);
        principalId = owner && ![...keys.values()].includes(OWNER_PRINCIPAL_ID) ? OWNER_PRINCIPAL_ID : `principal_${createHash("sha256").update(key).digest("hex").slice(0, 24)}`;
        keys.set(key, principalId);
      }
      return { principalId, trust: (principalId === OWNER_PRINCIPAL_ID ? "OWNER" : "GUEST") as "OWNER" | "GUEST" };
    },
    get: identity,
    async ensurePrincipalDirectories(principalId) {
      const base = principalRoot(principalId);
      const paths = { root: base, home: join(base, "home"), projects: join(base, "projects"), cache: join(base, "cache"), artifacts: join(base, "artifacts"), agent: join(base, "agent") };
      await Promise.all(Object.values(paths).map(ensureDir));
      return paths;
    },
    async ensureConversationWorkspace(conversationId) {
      const base = workspaceRoot(conversationId);
      const gid = taskTestWorkspaceGid(conversationId);
      const paths = { root: base, home: join(base, "home"), projects: join(base, "projects"), cache: join(base, "cache"), uid: gid, gid };
      await Promise.all([paths.root, paths.home, paths.projects, paths.cache].map(ensureDir));
      return paths;
    },
    async ensureConversationWorkspacePath(conversationId, workspaceId) {
      const dirs = await this.ensureConversationWorkspace(conversationId);
      return ensureDir(join(dirs.projects, workspaceId));
    },
    conversationWorkspacePath(conversationId, workspaceId) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(workspaceId) || workspaceId === "." || workspaceId === "..") throw new Error("WORKSPACE_ID_INVALID");
      return join(workspaceRoot(conversationId), "projects", workspaceId);
    },
    principalMemoryPath(principalId) { return join(principalRoot(principalId), "home", ".agent", "memory"); },
    workspaceMemoryPath(conversationId, workspaceId) { return join(workspaceRoot(conversationId), "projects", workspaceId, ".agent", "memory"); },
    principalProcessEnvironment(principalId) { return { ...process.env, HOME: join(principalRoot(principalId), "home") }; },
  } as unknown as PrincipalService;
}

export function taskTestWorkspacePath(root: string, conversationId: string, workspaceId: string): string {
  return join(root, "test-workspaces", createHash("sha256").update(conversationId).digest("hex"), "projects", workspaceId);
}

export function taskTestWorkspaceGid(conversationId: string): number {
  return 60_001 + Number.parseInt(createHash("sha256").update(conversationId).digest("hex").slice(0, 8), 16) % 5_535;
}
