import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";

const execFileAsync = promisify(execFile);

test("restore rejects legacy manifests that cannot provide a portable image", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-home-restore-manifest-"));
  try {
    await writeFile(join(root, "manifest.json"), JSON.stringify({
      format: "agent-home-deployment",
      version: 3,
      image: "agent-home:latest",
      runtimeSchemaVersion: 18,
      gatewaySchemaVersion: 6,
    }));
    await writeFile(join(root, "state.tar"), "not a tar archive");
    await assert.rejects(
      execFileAsync(join(process.cwd(), "scripts/restore.sh"), [root]),
      (error: unknown) => (error as { code?: number }).code === 1,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
