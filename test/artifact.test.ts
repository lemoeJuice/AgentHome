import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore, migrate } from "../src/db.js";
import { runtimeMigrations } from "../src/schema.js";
import { ArtifactService } from "../src/runtime/artifacts.js";

test("artifact publication validates realpath and separates publish from read", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-home-artifact-"));
  const project = join(root, "project"); const outside = join(root, "outside.txt");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(project));
  await writeFile(join(project, "ok.txt"), "safe"); await writeFile(outside, "private");
  await symlink(outside, join(project, "escape.txt"));
  const db = new SqliteStore(":memory:"); migrate(db, runtimeMigrations);
  const service = new ArtifactService(db, root);
  const capability = { publishTaskIds: ["task-1"], allowedDestinations: ["conversation-1"] };
  const artifact = await service.registerLocalArtifact({ path: join(project, "ok.txt"), taskId: "task-1", workerId: "worker-1", allowedRoots: [project], capability, maxBytes: 100 });
  assert.equal(artifact.filename, "ok.txt"); assert.equal(artifact.status, "AVAILABLE");
  await assert.rejects(() => service.registerLocalArtifact({ path: join(project, "escape.txt"), taskId: "task-1", allowedRoots: [project], capability, maxBytes: 100 }), /ARTIFACT_SOURCE_ROOT_DENIED/);
  await assert.rejects(() => service.registerLocalArtifact({ path: outside, taskId: "task-2", allowedRoots: [root], capability, maxBytes: 100 }), /ARTIFACT_PUBLISH_DENIED/);
  db.close(); await rm(root, { recursive: true, force: true });
});
