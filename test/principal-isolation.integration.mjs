import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { chown, chmod, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { SqliteStore, migrate } from "/app/dist/db.js";
import { runtimeMigrations } from "/app/dist/schema.js";
import { PrincipalService } from "/app/dist/runtime/principals.js";

const nonce = randomBytes(8).toString("hex");
const stateRoot = "/state";
const databasePath = join(stateRoot, "data", `principal-isolation-${nonce}.sqlite`);
const database = new SqliteStore(databasePath);
migrate(database, runtimeMigrations);
const principals = new PrincipalService(database, stateRoot);
const a = principals.resolveIdentity("principal-isolation", nonce, `a-${nonce}`);
const b = principals.resolveIdentity("principal-isolation", nonce, `b-${nonce}`);
let dirsA;
let dirsB;
let workspaceA;
let workspaceB;
let workspaceGidA;
let workspaceGidB;
let systemSecret;
let modelSecret;
let ownerTestRoot;

const principalExecHelper = "/usr/local/bin/agent-home-principal-exec";
const workspaceGroups = new Map();
const workspaceGidForPath = (cwd) => [...workspaceGroups].find(([root]) => cwd === root || cwd.startsWith(`${root}/`))?.[1] ?? 0;
const runIdentity = (uid, gid, command, cwd, env = process.env, timeout = 90_000, workspaceGid = 0) => {
  const result = spawnSync(principalExecHelper, [String(uid), String(gid), String(workspaceGid), "60", "17179869184", "64", "536870912", "--", "/bin/bash", "-c", command], {
    cwd,
    env,
    encoding: "utf8",
    timeout,
  });
  if (result.error) throw result.error;
  return result;
};
const runAs = (principal, command, cwd, timeout = 90_000) => {
  const identity = principals.get(principal.principalId);
  return runIdentity(identity.runtimeUid, identity.runtimeGid, command, cwd, principals.principalProcessEnvironment(principal.principalId), timeout, workspaceGidForPath(cwd));
};

try {
  dirsA = await principals.ensurePrincipalDirectories(a.principalId);
  dirsB = await principals.ensurePrincipalDirectories(b.principalId);
  const timestamp = new Date().toISOString();
  for (const conversationId of ["conversation-x", "conversation-y"]) database.run("INSERT INTO conversations(conversation_id,platform,account_id,kind,platform_conversation_id,thread_id_json,trust,memory_scopes_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)", conversationId, "principal-isolation", nonce, "group", conversationId, "null", "GUEST", JSON.stringify([`workspace:${conversationId}`]), timestamp, timestamp);
  workspaceA = await principals.ensureConversationWorkspacePath("conversation-x", "default");
  workspaceB = await principals.ensureConversationWorkspacePath("conversation-y", "default");
  workspaceGidA = (await principals.ensureConversationWorkspace("conversation-x")).gid;
  workspaceGidB = (await principals.ensureConversationWorkspace("conversation-y")).gid;
  workspaceGroups.set(workspaceA, workspaceGidA);
  workspaceGroups.set(workspaceB, workspaceGidB);
  assert.equal(workspaceA, await principals.ensureConversationWorkspacePath("conversation-x", "default"));
  assert.notEqual(workspaceA, workspaceB);
  assert.equal(database.get("SELECT 1 FROM conversation_workspaces WHERE conversation_id=? AND runtime_gid=?", "conversation-x", workspaceGidA) !== undefined, true);
  assert.notEqual(workspaceGidA, workspaceGidB);
  ownerTestRoot = join(stateRoot, "principals", `principal_integration_owner_${nonce}`);
  const ownerHome = join(ownerTestRoot, "home");
  const ownerWorkspace = join(ownerTestRoot, "projects", "default");
  await mkdir(ownerWorkspace, { recursive: true, mode: 0o700 });
  await mkdir(join(ownerHome, ".npm-global", "bin"), { recursive: true, mode: 0o700 });
  await mkdir(join(ownerHome, ".local", "bin"), { recursive: true, mode: 0o700 });
  await mkdir(join(ownerHome, "tmp"), { recursive: true, mode: 0o700 });
  await mkdir(join(ownerTestRoot, "cache", "npm"), { recursive: true, mode: 0o700 });
  await chown(ownerTestRoot, 10001, 10001);
  await chownTree(ownerTestRoot, 10001, 10001);
  const ownerEnv = { ...process.env, HOME: ownerHome, USER: "agent", LOGNAME: "agent", NPM_CONFIG_CACHE: join(ownerTestRoot, "cache", "npm"), NPM_CONFIG_PREFIX: join(ownerHome, ".npm-global"), TMPDIR: join(ownerHome, "tmp") };
  assert.deepEqual(principals.resolveIdentity("principal-isolation", nonce, `a-${nonce}`), a);
  assert.notEqual(principals.get(a.principalId).runtimeUid, principals.get(b.principalId).runtimeUid);
  assert.equal((await readFile("/proc/self/uid_map", "utf8")).includes("65536"), true, "outer user namespace must map the Principal UID range");

  systemSecret = join(stateRoot, "secrets", `principal-isolation-${nonce}`);
  await writeFile(systemSecret, "controller-secret\n", { mode: 0o600 });
  await chmod(systemSecret, 0o600);
  await chown(systemSecret, 0, 0);
  modelSecret = join("/state/model/pi/agent", `model-secret-test-${nonce}`);
  await writeFile(modelSecret, "MODEL_SECRET_TEST_VALUE\n", { mode: 0o600 });
  await chmod(modelSecret, 0o600);
  await chown(modelSecret, 10002, 10002);
  const otherFile = join(workspaceB, "private.txt");
  await writeFile(otherFile, "principal-b-private\n", { mode: 0o600 });
  await chown(otherFile, principals.get(b.principalId).runtimeUid, workspaceGidB);
  const privateFile = join(dirsB.home, "private.txt");
  await writeFile(privateFile, "principal-b-home\n", { mode: 0o600 });
  await chown(privateFile, principals.get(b.principalId).runtimeUid, principals.get(b.principalId).runtimeGid);

  assert.equal(runAs(a, "printf A > shared.txt", workspaceA).status, 0);
  assert.equal(runAs(b, "printf B >> shared.txt; printf B > from-b.txt", workspaceA).status, 0);
  assert.equal(runAs(a, "printf A >> from-b.txt", workspaceA).status, 0);
  for (const name of ["shared.txt", "from-b.txt"]) assert.equal((await stat(join(workspaceA, name))).gid, workspaceGidA);

  const identityProbe = runAs(a, `node -e 'const fs=require("node:fs");fs.writeFileSync("hello.txt","principal-persistent\\n");const denied=(p)=>{try{fs.readFileSync(p);return false}catch{return true}};console.log(JSON.stringify({uid:process.getuid(),gid:process.getgid(),groups:process.getgroups(),own:fs.readFileSync("hello.txt","utf8").trim(),otherDenied:denied(${JSON.stringify(otherFile)}),personalDenied:denied(${JSON.stringify(privateFile)}),databaseDenied:denied("/state/data/agent.db"),secretsDenied:denied(${JSON.stringify(systemSecret)}),runtimeSocketDenied:denied("/run/agent-home/control.sock")}))'`, workspaceA);
  assert.equal(identityProbe.status, 0, identityProbe.stderr);
  const identity = JSON.parse(identityProbe.stdout.trim());
  assert.equal(identity.uid, principals.get(a.principalId).runtimeUid);
  assert.equal(identity.gid, principals.get(a.principalId).runtimeGid);
  assert.equal(identity.groups.includes(0), false, "Worker must not inherit the Main group");
  assert.deepEqual(identity.groups, [workspaceGidA], "Worker must receive only its current Workspace supplementary GID");
  assert.equal(identity.own, "principal-persistent");
  assert.equal(identity.otherDenied, true);
  assert.equal(identity.personalDenied, true);
  assert.equal(identity.databaseDenied, true);
  assert.equal(identity.secretsDenied, true);
  assert.equal(identity.runtimeSocketDenied, true);

  const ownerProbe = runIdentity(10001, 10001, `node -e 'const fs=require("node:fs");const denied=(p)=>{try{fs.readFileSync(p);return false}catch{return true}};fs.writeFileSync("owner.txt","owner-workspace");console.log(JSON.stringify({uid:process.getuid(),gid:process.getgid(),own:fs.readFileSync("owner.txt","utf8"),principalDenied:denied(${JSON.stringify(otherFile)}),databaseDenied:denied("/state/data/agent.db"),modelSecretDenied:denied(${JSON.stringify(modelSecret)}),socketDenied:denied("/run/agent-home/control.sock")}))'`, ownerWorkspace, ownerEnv);
  assert.equal(ownerProbe.status, 0, ownerProbe.stderr);
  const ownerIdentity = JSON.parse(ownerProbe.stdout.trim());
  assert.equal(ownerIdentity.uid, 10001);
  assert.equal(ownerIdentity.gid, 10001);
  assert.equal(ownerIdentity.own, "owner-workspace");
  assert.equal(ownerIdentity.principalDenied, true);
  assert.equal(ownerIdentity.databaseDenied, true);
  assert.equal(ownerIdentity.modelSecretDenied, true);
  assert.equal(ownerIdentity.socketDenied, true);
  const modelProbe = runIdentity(10002, 10002, `node -e 'const fs=require("node:fs");console.log(fs.readFileSync(${JSON.stringify(modelSecret)},"utf8").trim())'`, "/state/model/pi/agent", { PATH: process.env.PATH, HOME: "/tmp", PI_CODING_AGENT_DIR: "/state/model/pi/agent" });
  assert.equal(modelProbe.status, 0, modelProbe.stderr);
  assert.equal(modelProbe.stdout.trim(), "MODEL_SECRET_TEST_VALUE");
  assert.notEqual(modelProbe.stdout.trim(), "");
  assert.equal(runIdentity(10001, 10001, `cat ${JSON.stringify(modelSecret)}`, ownerWorkspace, ownerEnv).status, 1, "Owner prompt-injection style read must fail at the filesystem boundary");
  assert.equal(runAs(a, `cat ${JSON.stringify(modelSecret)}`, workspaceA).status, 1, "Guest prompt-injection style read must fail at the filesystem boundary");

  const npmProject = join(workspaceA, "npm-project");
  await mkdir(npmProject, { mode: 0o2770 });
  await chown(npmProject, 0, workspaceGidA);
  await chmod(npmProject, 0o2770);
  const packageJson = join(npmProject, "package.json");
  const buildScript = join(npmProject, "build.cjs");
  await writeFile(packageJson, JSON.stringify({ name: "guest-project", version: "1.0.0", scripts: { build: "node build.cjs" } }));
  await writeFile(buildScript, 'require("node:fs").writeFileSync("built.txt", "ok")\n');
  await chown(packageJson, principals.get(a.principalId).runtimeUid, workspaceGidA);
  await chown(buildScript, principals.get(a.principalId).runtimeUid, workspaceGidA);
  const npm = runAs(a, "npm install --offline --no-audit --no-fund && npm run build && node --version && npm --version && python3 --version && git --version && (go version || true) && stat -c '%n %u:%g' built.txt", npmProject);
  assert.equal(npm.status, 0, npm.stderr);
  assert.ok(npm.stdout.includes("built.txt"), npm.stdout);
  assert.ok(npm.stdout.includes(`${principals.get(a.principalId).runtimeUid}:${workspaceGidA}`), npm.stdout);

  const laterTask = runAs(a, `test "$(cat hello.txt)" = "principal-persistent" && test -f ${JSON.stringify(join(npmProject, "built.txt"))}`, workspaceA);
  assert.equal(laterTask.status, 0, laterTask.stderr);
  const ownerNpmProject = join(ownerWorkspace, "npm-project");
  await mkdir(ownerNpmProject, { mode: 0o700 });
  await chown(ownerNpmProject, 10001, 10001);
  await writeFile(join(ownerNpmProject, "package.json"), JSON.stringify({ name: "owner-project", version: "1.0.0", scripts: { build: "node build.cjs" } }));
  await writeFile(join(ownerNpmProject, "build.cjs"), 'require("node:fs").writeFileSync("built.txt", "ok")\n');
  await chown(join(ownerNpmProject, "package.json"), 10001, 10001);
  await chown(join(ownerNpmProject, "build.cjs"), 10001, 10001);
  const ownerNpm = runIdentity(10001, 10001, "npm install --offline --no-audit --no-fund && npm run build && node --version && npm --version && python3 --version && git --version && stat -c '%u:%g' built.txt", ownerNpmProject, ownerEnv);
  assert.equal(ownerNpm.status, 0, ownerNpm.stderr);
  assert.ok(ownerNpm.stdout.includes("10001:10001"), ownerNpm.stdout);

  const publicNetwork = runAs(a, "node -e 'const net=require(\"node:net\");const s=net.connect(80,\"deb.debian.org\");s.setTimeout(5000);s.on(\"connect\",()=>{console.log(\"public-egress-ok\");s.destroy()});s.on(\"error\",e=>{console.error(e.code);process.exitCode=1});s.on(\"timeout\",()=>{console.error(\"timeout\");s.destroy();process.exitCode=1})'", workspaceA, 10_000);
  assert.equal(publicNetwork.status, 0, publicNetwork.stderr);
  assert.match(publicNetwork.stdout, /public-egress-ok/);

  const privateAddress = await lookup("snowluma");
  const privateNetwork = runAs(a, `node -e 'const net=require("node:net");const s=net.connect(3000,${JSON.stringify(privateAddress.address)});s.setTimeout(2500);s.on("connect",()=>{console.error("private egress unexpectedly connected");s.destroy();process.exitCode=1});s.on("error",()=>console.log("private-egress-blocked"));s.on("timeout",()=>{s.destroy();console.log("private-egress-blocked")})'`, workspaceA, 10_000);
  assert.equal(privateNetwork.status, 0, privateNetwork.stderr);
  assert.match(privateNetwork.stdout, /private-egress-blocked/);

  console.log(JSON.stringify({ distinctPrincipalUids: "passed", sharedConversationWorkspaceGid: "passed", isolatedConversationWorkspaceGid: "passed", personalStateIsolation: "passed", modelCredentialIsolation: "passed", systemStateDenied: "passed", collaborativeFileModes: "passed", principalNpmInstallBuild: "passed", publicNetwork: "passed", privateNetworkBlocked: "passed", optionalGo: spawnSync("go", ["version"], { encoding: "utf8" }).status === 0 ? "installed" : "not installed in image" }));
} finally {
  if (ownerTestRoot) await rm(ownerTestRoot, { recursive: true, force: true });
  if (workspaceA) await rm(dirname(dirname(workspaceA)), { recursive: true, force: true });
  if (workspaceB) await rm(dirname(dirname(workspaceB)), { recursive: true, force: true });
  if (dirsA) await rm(dirsA.root, { recursive: true, force: true });
  if (dirsB) await rm(dirsB.root, { recursive: true, force: true });
  if (systemSecret) await rm(systemSecret, { force: true }).catch(() => undefined);
  if (modelSecret) await rm(modelSecret, { force: true }).catch(() => undefined);
    database.run("DELETE FROM platform_identities WHERE platform=? AND account_id=?", "principal-isolation", nonce);
  database.run("DELETE FROM principals WHERE principal_id IN (?,?)", a.principalId, b.principalId);
  database.close();
  await rm(databasePath, { force: true });
  await rm(`${databasePath}-wal`, { force: true });
  await rm(`${databasePath}-shm`, { force: true });
}

async function chownTree(path, uid, gid) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) await chownTree(child, uid, gid);
    else await chown(child, uid, gid);
  }
  await chown(path, uid, gid);
}
