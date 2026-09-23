import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { SqliteStore, migrate } from "../src/db.js";
import { runtimeMigrations } from "../src/schema.js";
import { ArtifactService } from "../src/runtime/artifacts.js";
import { ArtifactTransferServer } from "../src/runtime/artifact-transfer.js";
import type { Logger } from "../src/shared/logger.js";

const logger = { child: () => logger, info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger;

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

test("Artifact transfer streams signed, expiring references without exposing paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-home-transfer-"));
  const project = join(root, "project");
  await mkdir(project);
  await writeFile(join(project, "large.bin"), Buffer.alloc(64 * 1024, 7));
  const db = new SqliteStore(":memory:"); migrate(db, runtimeMigrations);
  const artifacts = new ArtifactService(db, root);
  const capability = { publishTaskIds: ["task-1"], allowedDestinations: ["conversation-1"] };
  const artifact = await artifacts.registerLocalArtifact({ path: join(project, "large.bin"), taskId: "task-1", allowedRoots: [project], capability, maxBytes: 100000 });
  const port = await freePort();
  const transfer = new ArtifactTransferServer(artifacts, { baseUrl: `http://127.0.0.1:${port}`, secret: "transfer-secret", port }, logger);
  await transfer.start();
  try {
    const url = transfer.issueUrl(artifact.ref, { taskId: "task-1", destination: "conversation-1", capability });
    const response = await fetch(url);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-length"), String(64 * 1024));
    assert.equal((await response.arrayBuffer()).byteLength, 64 * 1024);
    const tampered = url.replace("token=", "token=x");
    assert.equal((await fetch(tampered)).status, 403);
    const expires = transfer.issueUrl(artifact.ref, { taskId: "task-1", destination: "conversation-1", capability, ttlMs: 1000 });
    await delay(1100);
    assert.equal((await fetch(expires)).status, 403);
  } finally {
    await transfer.stop(); db.close(); await rm(root, { recursive: true, force: true });
  }
});
