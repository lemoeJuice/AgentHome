# Agent Home

Agent Home is a durable QQ-connected Agent runtime built around Rootless Podman, OneBot/SnowLuma, and Pi. The host Bot Gateway owns platform ingress, routing, load-time plugins, and the Controller. The Agent Home container owns Runtime, Main/Worker Pi sessions, tasks, memory, artifacts, and canonical `/state`.

## Quick Start

```bash
pnpm install
./scripts/configure-podman-snowluma.sh
./scripts/doctor.sh
./scripts/start.sh
```

`configure-podman-snowluma.sh` detects a usable local rootless Podman installation and automatically installs Podman with `pacman`, `apt-get`, `dnf`, `yum`, `zypper`, or `apk` when needed. It then uses the fixed `docker.io/motricseven7/snowluma:latest` image, creates persistent QQ volumes, and starts the SnowLuma container. Open the printed noVNC URL on `127.0.0.1:6081` to scan the QQ login QR code, then press Enter. It never asks for a Podman path or a SnowLuma access token, and refuses to claim success unless the local rootless engine is reachable.

The configure flow is safe to rerun: existing Agent Home and SnowLuma images, containers, dependencies, volumes, and runtime bootstrap are reused. Set `AGENT_HOME_REBUILD_IMAGE=1`, `SNOWLUMA_REFRESH_IMAGE=1`, `AGENT_HOME_REFRESH_DEPS=1`, or `AGENT_HOME_REBOOTSTRAP=1` only when an explicit refresh is needed. `scripts/retry-setup-podman.sh` retries the Podman image/build phase up to 100 times by default.

Podman setup uses an Agent Home-local storage configuration under `.agent-home/podman/`. It selects the native `btrfs` driver on Btrfs, `fuse-overlayfs` when available elsewhere, and `vfs` as a portable fallback. On Btrfs without `fuse-overlayfs`, it builds through a temporary rootless container and `commit` instead of Buildah's unsupported overlay build context. This avoids changing or reusing an incompatible global rootless storage database.

Useful commands:

```bash
./scripts/build.sh
./scripts/setup.sh
./scripts/setup-podman-portable.sh
./scripts/setup-snowluma.sh
./scripts/init-container.sh
./scripts/install-pi.sh
./scripts/start.sh
./scripts/stop.sh
./scripts/restart.sh
./scripts/status.sh
./scripts/doctor.sh
./scripts/test.sh
./scripts/backup.sh
./scripts/restore.sh backups/<backup-directory>
pnpm integration:e2e
```

Runtime backup control is available through `agent-home control backup-prepare`
and `agent-home control backup-finish`; `scripts/backup.sh` uses this protocol
before exporting the state volume.

## Configuration

`config.example.json` is a committed application template. `config/agent-home.json` is deployment configuration and is ignored by Git. Setup automatically creates the ignored `config/owner.json` from `config/owner.example.json`; it is optional. Until a complete identity is configured, the runtime has no Owner and all Owner-only authorization remains disabled. Podman installation is handled by `scripts/setup-podman-portable.sh` without a user-supplied binary path.

The common chat model always namespaces platform, account, conversation, thread, and message IDs. `null` means a supported field has no value; `NOT_IMPLEMENTED` is a structured unsupported-field sentinel. SnowLuma is deployed as a separate container on `agent-home-net` using its official Docker framework defaults and persistent QQ volumes.

## Runtime Boundaries

Business ingress follows:

```text
SnowLuma → QQChatPlatformAdapter → Router → Controller
→ podman exec -i control stream → container-local Unix socket
→ durable SQLite ingress → Runtime/Main
```

Direct plugin commands bypass Main and use the Host Gateway's SnowLuma adapter. Runtime/Main platform reads, attachment resolution, and outbound sends use the official `@snowluma/mcp` stdio client launched by Runtime; Gateway MCP is reserved for Agent Actions and Worker bindings. Worker files must be registered as `ArtifactRef` objects before delivery; raw local paths are never passed to QQ.

## External Integrations

The production Gateway OneBot adapter uses forward WebSocket events and SnowLuma HTTP action paths for ingress and direct plugin commands. Runtime starts the pinned, image-installed `@snowluma/mcp@1.14.15` server over stdio with `SNOWLUMA_MCP_ENDPOINT`, `SNOWLUMA_MCP_TOKEN`, and `SNOWLUMA_MCP_MODE=write`; Main calls `query_action`/`invoke_action` for platform operations. Inbound attachments cross the Controller as metadata and are downloaded only when Main invokes `get_attachment`, which uses MCP's `download_file_stream`. Pi is isolated in `src/runtime/pi.ts` and uses its real CLI print/session interface. Live verification requires a completed QR login, a Pi installation, and rootless Podman.

Small Main artifacts are sent through OneBot's `base64://` file reference via MCP. Larger files are copied into the MCP upload root and sent through `upload_file_stream`; no unrestricted Agent Home filesystem URL is exposed.

Gateway Plugin artifacts are copied into the Gateway artifact store and sent inline through OneBot's `base64://` reference; the production Host Gateway does not expose an artifact HTTP port to SnowLuma. Artifacts over 8 MiB require a platform-specific upload capability and are rejected until one is configured. `pnpm integration:e2e` is opt-in and requires a running rootless Podman/SnowLuma/Pi deployment.

Gateway MCP exposes no Agent Actions unless either `GATEWAY_MCP_ALLOWED_ACTIONS` or `plugins.allowedActions` is configured. It implements the standard MCP initialize/tools flow plus the internal control methods used for Worker binding. `GATEWAY_MCP_ACTION_TIMEOUT_MS` bounds Agent Action execution (default 30 seconds). Setup generates the Main token and initializes the private `.agent-home/mcp-worker-bindings.json` registry. Worker bearer tokens are resolved server-side to persisted `taskId`/`workerId`/action bindings; caller-supplied task or capability fields are ignored. The server refuses an unauthenticated non-loopback bind.

Main Pi sessions use a fixed Agent Home tool extension over a Runtime-owned, mode-600 Unix socket. The Runtime binds each socket token to the current conversation capability and rejects caller-supplied identity or scope. Main Pi built-in tools, project extensions, skills, and context files are disabled; Worker Pi sessions retain only their separate bwrap-scoped execution surface. Pi 0.86.1 turns settle on `agent_settled`, after retries, compaction, and queued continuations.

Pi defaults to the native `openai-codex` provider and `gpt-5.5`. After the container is running, use `pnpm pi:login` (or `scripts/pi-login.sh`) from the Host, then run `/login` in the attached Pi session. Credentials are stored at `/state/home/.pi/agent/auth.json` inside the named state volume; no Host bind mount or credential argument is used.

## Tests

Tests use in-memory SQLite and narrow test doubles only at service boundaries. Production code retains real OneBot, Podman, and Pi paths. The test suite covers namespaced IDs, direct command bypass, wake policy, durable ingress deduplication, per-conversation Main queue ordering, outbound intent replay, authorization attenuation, scope isolation, worker questions/answers, cancellation, writer locks, recovery, and artifact path safety. CI runs typecheck, build, tests, shell syntax, and whitespace checks.
