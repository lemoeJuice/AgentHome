import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SqliteStore, migrate } from "../src/db.js";
import { runtimeMigrations } from "../src/schema.js";
import { ModelPlaneService, MODEL_RUNTIME_GID, MODEL_RUNTIME_UID } from "../src/runtime/model-plane.js";
import { OWNER_RUNTIME_UID } from "../src/runtime/principals.js";

test("Model Plane migration moves Pi credentials and session state out of Principal paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-home-model-plane-migration-"));
  const db = new SqliteStore(join(root, "agent.db"));
  migrate(db, runtimeMigrations);
  const ownerHome = join(root, "principals", `uid-${OWNER_RUNTIME_UID}`, "home");
  const oldAuth = join(ownerHome, ".pi", "agent");
  const oldMain = join(ownerHome, ".pi", "main", "sessions", "conversation-1", "session.jsonl");
  const oldWorker = join(root, "workers", "orchestrators", "worker-legacy", "session", "session.jsonl");
  const oldWorkspace = join(ownerHome, ".pi", "main", "workspaces", "conversation-1");
  const timestamp = new Date().toISOString();
  await mkdir(oldAuth, { recursive: true });
  await mkdir(dirname(oldMain), { recursive: true });
  await mkdir(dirname(oldWorker), { recursive: true });
  await writeFile(join(oldAuth, "auth.json"), "model-only-auth");
  await writeFile(oldMain, `${JSON.stringify({ type: "session", id: "main-session", cwd: oldWorkspace })}\n${JSON.stringify({ type: "message", message: "preserved-main-session" })}\n`);
  await writeFile(oldWorker, `${JSON.stringify({ type: "session", id: "worker-session", cwd: "/state/projects/default" })}\n${JSON.stringify({ type: "message", message: "preserved-worker-session" })}\n`);
  db.run("INSERT INTO conversations(conversation_id,platform,account_id,kind,platform_conversation_id,thread_id_json,trust,memory_scopes_json,created_at,updated_at,main_session_id,main_session_path) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", "conversation-1", "qq", "a", "private", "user", "null", "OWNER", "[]", timestamp, timestamp, "main-session", oldMain);
  db.run("INSERT INTO tasks(id,title,goal,status,requester_json,trust,origin_conversation_id,notification_conversation_id,capabilities_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)", "task-legacy", "legacy", "legacy", "RUNNING", JSON.stringify({ platform: "qq", accountId: "a", userId: "u" }), "OWNER", "conversation-1", "conversation-1", "{}", timestamp, timestamp);
  db.run("INSERT INTO worker_executions(id,task_id,objective,status,harness,harness_session_id,harness_session_path,updated_at) VALUES (?,?,?,?,?,?,?,?)", "worker-legacy", "task-legacy", "legacy", "RUNNING", "pi", "worker-session", oldWorker, timestamp);
  try {
    const plane = new ModelPlaneService(db, root);
    await plane.ensure();
    await plane.migrateLegacyState();
    assert.equal(await readFile(join(plane.paths.agentDir, "auth.json"), "utf8"), "model-only-auth");
    await assert.rejects(readFile(join(ownerHome, ".pi", "agent", "auth.json"), "utf8"));
    const mainPath = db.get<{ main_session_path: string }>("SELECT main_session_path FROM conversations WHERE conversation_id=?", "conversation-1")?.main_session_path;
    const workerPath = db.get<{ harness_session_path: string }>("SELECT harness_session_path FROM worker_executions WHERE id=?", "worker-legacy")?.harness_session_path;
    assert.equal(mainPath, join(plane.paths.mainSessions, createHash("sha256").update("conversation-1").digest("hex"), "session.jsonl"));
    assert.equal(workerPath, join(plane.paths.workerSessions, "worker-legacy", "session.jsonl"));
    const mainRecords = (await readFile(mainPath!, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const workerRecords = (await readFile(workerPath!, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(mainRecords[0].cwd, join(plane.paths.mainSessions, createHash("sha256").update("conversation-1").digest("hex")));
    assert.equal(mainRecords[1].message, "preserved-main-session");
    assert.equal(workerRecords[0].cwd, join(plane.paths.workerSessions, "worker-legacy"));
    assert.equal(workerRecords[1].message, "preserved-worker-session");
    const owner = await stat(plane.paths.agentDir);
    assert.equal(owner.uid, process.getuid?.() === 0 ? MODEL_RUNTIME_UID : process.getuid?.());
    assert.equal(owner.gid, process.getgid?.() === 0 ? MODEL_RUNTIME_GID : process.getgid?.());
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
});

test("Model Plane migration safely reconciles legacy placeholders with an existing destination", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-home-model-plane-reconcile-"));
  const db = new SqliteStore(join(root, "agent.db")); migrate(db, runtimeMigrations);
  const legacy = join(root, "principals", `uid-${OWNER_RUNTIME_UID}`, "home", ".pi", "agent");
  const destination = join(root, "model", "pi", "agent");
  try {
    await mkdir(legacy, { recursive: true });
    await mkdir(destination, { recursive: true });
    await writeFile(join(legacy, "auth.json"), JSON.stringify({ token: "legacy-credential" }));
    await writeFile(join(legacy, "models-store.json"), "{}\n");
    await writeFile(join(legacy, "legacy-settings.json"), JSON.stringify({ retained: true }));
    await writeFile(join(destination, "auth.json"), "{}\n");
    await writeFile(join(destination, "models-store.json"), JSON.stringify({ catalog: "current" }));

    const plane = new ModelPlaneService(db, root);
    await plane.ensure();
    await plane.migrateLegacyState();

    assert.deepEqual(JSON.parse(await readFile(join(destination, "auth.json"), "utf8")), { token: "legacy-credential" });
    assert.deepEqual(JSON.parse(await readFile(join(destination, "models-store.json"), "utf8")), { catalog: "current" });
    assert.deepEqual(JSON.parse(await readFile(join(destination, "legacy-settings.json"), "utf8")), { retained: true });
    await assert.rejects(readFile(join(legacy, "auth.json"), "utf8"));

    await plane.ensure();
    await plane.migrateLegacyState();
    assert.deepEqual(JSON.parse(await readFile(join(destination, "auth.json"), "utf8")), { token: "legacy-credential" });
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
});

test("Model Plane migration preserves conflicting non-placeholder credentials and fails closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-home-model-plane-conflict-"));
  const db = new SqliteStore(join(root, "agent.db")); migrate(db, runtimeMigrations);
  const legacy = join(root, "principals", `uid-${OWNER_RUNTIME_UID}`, "home", ".pi", "agent");
  const destination = join(root, "model", "pi", "agent");
  try {
    await mkdir(legacy, { recursive: true });
    await mkdir(destination, { recursive: true });
    await writeFile(join(legacy, "auth.json"), JSON.stringify({ token: "legacy-credential" }));
    await writeFile(join(destination, "auth.json"), JSON.stringify({ token: "model-plane-credential" }));
    const plane = new ModelPlaneService(db, root);
    await plane.ensure();
    await assert.rejects(plane.migrateLegacyState(), /MODEL_AGENT_MIGRATION_COLLISION/);
    assert.deepEqual(JSON.parse(await readFile(join(legacy, "auth.json"), "utf8")), { token: "legacy-credential" });
    assert.deepEqual(JSON.parse(await readFile(join(destination, "auth.json"), "utf8")), { token: "model-plane-credential" });
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
});
