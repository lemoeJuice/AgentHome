import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, chown, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("workspace group and umask allow different Principals to create and edit shared files", async (context) => {
  if (process.getuid?.() !== 0 || process.getgid?.() !== 0) { context.skip("requires root to exercise setgroups and setuid"); return; }
  const probe = spawnSync("cc", ["--version"], { encoding: "utf8" });
  if (probe.error) { context.skip("requires a C compiler for the production UID/GID helper"); return; }
  const root = await mkdtemp(join(tmpdir(), "agent-home-unix-workspace-"));
  const workspace = join(root, "workspace");
  const helper = join(root, "guest-exec");
  try {
    execFileSync("cc", ["-Wall", "-Wextra", "-Werror", "-O2", "-o", helper, "src/runtime/guest-exec.c"]);
    const workspaceGid = 30001;
    const principalA = { uid: 20001, gid: 20001 };
    const principalB = { uid: 20002, gid: 20002 };
    await import("node:fs/promises").then(({ mkdir }) => mkdir(workspace, { mode: 0o2770 }));
    await chown(workspace, 0, workspaceGid);
    await chmod(workspace, 0o2770);
    const run = (principal: typeof principalA, script: string) => {
      const result = spawnSync(helper, [String(principal.uid), String(principal.gid), String(workspaceGid), "30", "100000000", "20", "1000000", "--", "/bin/sh", "-c", `${script}; id -G`], { cwd: workspace, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(result.stdout.trim().split(/\s+/).map(Number).sort((a, b) => a - b), [principal.gid, workspaceGid].sort((a, b) => a - b));
    };
    run(principalA, "printf A > from-a");
    run(principalB, "printf B >> from-a; printf B > from-b");
    run(principalA, "printf A >> from-b");
    for (const name of ["from-a", "from-b"]) {
      const info = await stat(join(workspace, name));
      assert.equal(info.gid, workspaceGid);
      assert.ok((info.mode & 0o660) === 0o660);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
