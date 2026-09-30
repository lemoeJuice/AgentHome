import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelPlaneService, MODEL_RUNTIME_GID, MODEL_RUNTIME_UID } from "../src/runtime/model-plane.js";

test("Model Plane provisions only its canonical auth and session roots", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-home-model-plane-current-"));
  try {
    const plane = new ModelPlaneService(root);
    await plane.ensure();
    const auth = await stat(plane.paths.agentDir);
    assert.equal(auth.uid, process.getuid?.() === 0 ? MODEL_RUNTIME_UID : process.getuid?.());
    assert.equal(auth.gid, process.getgid?.() === 0 ? MODEL_RUNTIME_GID : process.getgid?.());
    await plane.ensureSessionDirectory(plane.paths.mainSessions);
    await assert.rejects(() => plane.ensureSessionDirectory(join(root, "principals", "outside")), /MODEL_SESSION_DIRECTORY_OUTSIDE_MODEL_PLANE/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Model Plane startup does not inspect or migrate a Principal home directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-home-model-plane-no-legacy-scan-"));
  const oldPath = join(root, "principals", "old-user", "home", ".pi", "agent");
  try {
    await mkdir(oldPath, { recursive: true });
    await writeFile(join(oldPath, "auth.json"), "private-data");
    const plane = new ModelPlaneService(root);
    await plane.ensure();
    assert.equal(await readFile(join(oldPath, "auth.json"), "utf8"), "private-data");
    await assert.rejects(() => readFile(join(plane.paths.agentDir, "auth.json"), "utf8"));
  } finally { await rm(root, { recursive: true, force: true }); }
});
