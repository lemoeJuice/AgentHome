import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore, migrate } from "../src/db.js";
import { gatewayMigrations } from "../src/gateway/state.js";
import { GatewayArtifactService } from "../src/gateway/artifacts.js";
import { Logger } from "../src/shared/logger.js";

test("Gateway artifacts are copied, destination-bound, and transferred by signed URL", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-home-gateway-artifact-"));
  const db = new SqliteStore(join(root, "gateway.db"));
  migrate(db, gatewayMigrations);
  const logger = new Logger("test", "error");
  const service = new GatewayArtifactService(db, join(root, "gateway.db"), logger, { baseUrl: "http://127.0.0.1:0", secret: "test-secret", port: 0, host: "127.0.0.1" });
  const pluginRoot = join(root, "plugin");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(pluginRoot));
  await writeFile(join(pluginRoot, "result.txt"), "gateway result");
  const registered = await service.registerLocalArtifact({ path: join(pluginRoot, "result.txt"), allowedRoot: pluginRoot, conversationId: "conversation-1", requesterId: "user-1" });
  assert.equal(await readFile(join(root, "gateway-artifacts", registered.ref.artifactId), "utf8"), "gateway result");
  assert.throws(() => service.issueUrl({ authority: "agent-home", artifactId: registered.ref.artifactId }, "conversation-1"), /AUTHORITY_REQUIRED/);
  assert.throws(() => service.issueUrl(registered.ref, "conversation-2"), /DESTINATION_DENIED/);
  await service.start();
  try {
    const url = service.issueUrl(registered.ref, "conversation-1").replace("http://127.0.0.1:0", `http://127.0.0.1:${service.getTransferPort()}`);
    const response = await fetch(url);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "gateway result");
    db.run("UPDATE gateway_artifacts SET expires_at=? WHERE id=?", "2020-01-01T00:00:00.000Z", registered.ref.artifactId);
    assert.throws(() => service.issueUrl(registered.ref, "conversation-1"), /GATEWAY_ARTIFACT_EXPIRED/);
  } finally {
    await service.stop(); db.close(); await rm(root, { recursive: true, force: true });
  }
});
