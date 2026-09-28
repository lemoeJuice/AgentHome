# Agent Home

Agent Home is a durable QQ-connected Agent runtime built around Rootless Podman, OneBot/SnowLuma, and Pi. The host Bot Gateway owns platform ingress, routing, load-time plugins, and the Controller. The Agent Home container owns Runtime, Main/Worker Pi sessions, tasks, memory, artifacts, and canonical `/state`.

## Quick Start

```bash
./scripts/deploy.sh
./scripts/doctor.sh
```

Host prerequisite: Node.js `>=22.5` with `npm` or `pnpm`; `deploy.sh` installs project dependencies itself, so a separate `pnpm install` is not required. The script can install Podman through the host package manager, but it does not install Node.js.

`scripts/deploy.sh` is the single full-deployment entrypoint (also available through the compatibility alias `scripts/configure-podman-snowluma.sh`). It checks host dependencies and existing images/containers, checks registry image updates, prepares a usable rootless Podman installation, installs Pi, and starts the runtime and host Gateway. If the configured Agent Home volume does not exist, startup asks whether to initialize an empty volume or restore a deployment backup. For migration, provide the backup directory produced by `scripts/backup.sh`, or the path to one of its files; it must include `manifest.json`, `state.tar`, `image.tar`, and all companion files referenced by the manifest. `scripts/migrate.sh <backup-directory-or-file>` remains a shortcut that selects restore and uses the same deployment flow. If Pi has no provider/model saved in its own settings, startup offers to open Pi's built-in model selector or skip; it never maintains a separate provider/model catalog. Podman is automatically installed with `pacman`, `apt-get`, `dnf`, `yum`, `zypper`, or `apk` when needed. SnowLuma uses the fixed `docker.io/motricseven7/snowluma:latest` image and persistent QQ volumes. OneBot HTTP/WS bind to `127.0.0.1` by default; noVNC and the WebUI bind to `0.0.0.0` on ports `6081` and `5100`. Edit `config.json` under `snowluma.deployment` to change these values. QQ login is the final deployment stage, after containers, Pi, health checks, and Gateway startup, so the QR does not age during setup. When OneBot is offline, the script screenshots the desktop, recognizes a QR with ZXing-C++, and renders a scannable terminal QR with `qrencode`; when no QR is decodable it clicks the fixed refresh point (default `960,582`, configurable with `SNOWLUMA_QR_REFRESH_X/Y`). After printing the QR it waits for a key: it checks whether login completed and, if OneBot is still offline, refreshes and prints a new QR. Host-side QR output needs ImageMagick, ZXing-C++, and `qrencode`; QQ desktop input uses XTest in the SnowLuma container. The same config enables declarative EULA/privacy consent for unattended setup. It never asks for a Podman path or a SnowLuma access token, and refuses to claim success unless the local rootless engine is reachable.

The deployment flow is safe to rerun after interruption: unchanged source/dependency fingerprints, containers, volumes, and initialized state are reused; startup resumes the remaining setup phases. Changed lockfiles or Agent Home source trigger the required dependency/image refresh automatically. SnowLuma and the base image are checked against the registry. Set `AGENT_HOME_REBUILD_IMAGE=1`, `SNOWLUMA_REFRESH_IMAGE=1`, `AGENT_HOME_REFRESH_DEPS=1`, or `AGENT_HOME_REBOOTSTRAP=1` to force a refresh. `scripts/retry-setup-podman.sh` retries the Podman image/build phase up to 100 times by default.

Podman setup uses an Agent Home-local storage configuration under `.agent-home/podman/`. It selects the native `btrfs` driver on Btrfs, `fuse-overlayfs` when available elsewhere, and `vfs` as a portable fallback. On Btrfs without `fuse-overlayfs`, it builds through a temporary rootless container and `commit` instead of Buildah's unsupported overlay build context. This avoids changing or reusing an incompatible global rootless storage database.

Useful commands:

```bash
./scripts/build.sh
./scripts/setup.sh
./scripts/setup-podman-portable.sh
./scripts/setup-snowluma.sh
./scripts/init-container.sh
./scripts/install-pi.sh
./scripts/pi-provider-onboarding.sh
./scripts/pi-login.sh
./scripts/qq-login.sh
./scripts/migrate.sh backups/<backup-directory>
./scripts/upgrade.sh
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

Host deployment-generated data is kept under `.agent-home/`: Podman state and credentials live at its root, while Gateway databases, plugin data, artifacts, logs, and PID files live in `.agent-home/runtime-state/`. The former empty top-level `runtime/` directory has been removed; Runtime source code lives in `src/runtime/`.

`config.example.json` is the committed combined application/SnowLuma deployment template. `config.json` is the local deployment configuration and is ignored by Git. Configure all authorized Owners in its `owners` array; each identity includes `platform`, `accountId`, and `userId` (for example, two QQ Owners are two entries with `platform: "qq"` and the same `accountId`). With an empty or missing array, Owner-only authorization remains disabled. Podman installation is handled by `scripts/setup-podman-portable.sh` without a user-supplied binary path.

SnowLuma deployment settings are stored in `config.json` under `snowluma.deployment`, including service/UI bind addresses, host ports, and declarative EULA/privacy acceptance. Consent values are passed to the SnowLuma container as ephemeral settings; SnowLuma does not persist them as a consent record. `SNOWLUMA_SERVICE_BIND_ADDRESS`, `SNOWLUMA_UI_BIND_ADDRESS`, `SNOWLUMA_HTTP_PORT`, `SNOWLUMA_WS_PORT`, `SNOWLUMA_WEBUI_PORT`, `SNOWLUMA_NOVNC_PORT`, `SNOWLUMA_ACCEPT_EULA`, and `SNOWLUMA_ACCEPT_PRIVACY` can override the JSON values for one command invocation.

Application endpoints and service settings live in `config.json`: `snowluma.endpoint` and `snowluma.apiEndpoint` select OneBot WebSocket/HTTP endpoints, `gateway.mcpPort` and optional `gateway.mcpHost` configure Gateway MCP, and `gateway.mcpActionTimeoutMs` sets its action timeout. `network.proxyRelay` controls the host-local TCP relay used by the Agent Home container: `enabled`, `listenPort` (default `17890`), `upstreamHost` (default `127.0.0.1`), and `upstreamPort` (default `7897`, Mihomo's host-local HTTP proxy port). The relay accepts only connections originating from this host and forwards them to Mihomo without enabling Mihomo LAN access. It retries interrupted CONNECT/TLS handshakes up to three times and only replays a complete initial TLS ClientHello; established TLS streams and application requests are never replayed. When `network.modelProxyUrl` is omitted, Agent Home derives the container proxy URL from the relay port; set it explicitly to override that URL, or set it to an empty string to disable container proxy variables. SnowLuma does not use this relay. The corresponding deployment environment overrides are `GATEWAY_MCP_PORT`, `GATEWAY_MCP_HOST`, `GATEWAY_MCP_ACTION_TIMEOUT_MS`, and `AGENT_HOME_MODEL_PROXY_URL`.

## Deployment Lifecycle

Use `scripts/deploy.sh` for a new deployment or to check/reconcile an existing one; existing dependencies, images, containers, and initialized state are reused when possible. If the Agent Home volume is missing, the entrypoint offers fresh initialization or backup restore. Set `AGENT_HOME_MIGRATION_BACKUP` to select a backup directory/file non-interactively. Set `AGENT_HOME_REBUILD_IMAGE=1`, `SNOWLUMA_REFRESH_IMAGE=1`, or `AGENT_HOME_REFRESH_DEPS=1` to refresh the corresponding resources. Use `scripts/backup.sh` on the source host to create a portable migration directory. Use `scripts/upgrade.sh` after pulling project updates; it creates a backup, rebuilds the Agent Home image from the current source, replaces the container while retaining the named state volume, reapplies bootstrap configuration, and restarts the host Gateway.

The common chat model always namespaces platform, account, conversation, thread, and message IDs. `null` means a supported field has no value; `NOT_IMPLEMENTED` is a structured unsupported-field sentinel. SnowLuma is deployed as a separate container on `agent-home-net` using its official Docker framework defaults and persistent QQ volumes.

## Runtime Boundaries

Business ingress follows:

```text
SnowLuma → QQChatPlatformAdapter → Router → Controller
→ podman exec -i control stream → container-local Unix socket
→ durable SQLite ingress → Runtime/Main
```

Direct plugin commands bypass Main and use the Host Gateway's SnowLuma adapter. Runtime/Main platform reads, attachment resolution, and outbound sends use the official `@snowluma/mcp` stdio client launched by Runtime; Gateway MCP is reserved for Agent Actions and Worker bindings. Worker files must be registered as `ArtifactRef` objects before delivery; raw local paths are never passed to QQ.

Send `/help` in QQ to list the Runtime and Gateway commands currently loaded. Slash commands in groups follow `chat.qq.commandRequireMention` (default `false`); private-chat commands never need an @ mention. Model commands require the configured Owner identity, but can be used from either private or group chat (subject to the group @ setting). Group natural-language messages use the configured wake policy; the default `explicit_wake` requires an @ mention or reply to the bot.

## External Integrations

The production Gateway OneBot adapter uses forward WebSocket events and SnowLuma HTTP action paths for ingress and direct plugin commands. Controller ingress carries only the normalized text summary, attachment type markers such as `[图片]`, and trusted message/reply references; it does not retain or transport platform attachment metadata, URLs, IDs, or raw segments. Runtime starts the pinned, image-installed upstream `@snowluma/mcp@1.14.15` server over stdio with `SNOWLUMA_MCP_ENDPOINT`, `SNOWLUMA_MCP_TOKEN`, and `SNOWLUMA_MCP_MODE=write`. Main can answer from the summary or discover and invoke SnowLuma's native OneBot actions on demand; no current-message/history/attachment helper tools are required. Stream download results are converted by Runtime into authorized ArtifactRefs (and image content when supported), rather than exposing MCP-host file paths to Pi. Runtime restricts and audits direct `query_action` / `invoke_action` calls; invocation is currently Owner-only. This supports catalog-backed operations such as sending QQ private messages and processing received friend-add requests without exposing Pi's native arbitrary tools. Pi is isolated in `src/runtime/pi.ts` and uses its real CLI print/session interface. Live verification requires a completed QR login, a Pi installation, and rootless Podman.

Small Main artifacts are sent through OneBot's `base64://` file reference via MCP. Larger files are copied into the MCP upload root and sent through `upload_file_stream`; no unrestricted Agent Home filesystem URL is exposed.

Gateway Plugin artifacts are copied into the Gateway artifact store and sent inline through OneBot's `base64://` reference; the production Host Gateway does not expose an artifact HTTP port to SnowLuma. Artifacts over 8 MiB require a platform-specific upload capability and are rejected until one is configured. `pnpm integration:e2e` is opt-in and requires a running rootless Podman/SnowLuma/Pi deployment.

Gateway MCP exposes no Agent Actions unless either `GATEWAY_MCP_ALLOWED_ACTIONS` or `plugins.allowedActions` is configured. It implements the standard MCP initialize/tools flow plus the internal control methods used for Worker binding. `GATEWAY_MCP_ACTION_TIMEOUT_MS` bounds Agent Action execution (default 30 seconds). Setup generates the Main token and initializes the private `.agent-home/mcp-worker-bindings.json` registry. Worker bearer tokens are resolved server-side to persisted `taskId`/`workerId`/action bindings; caller-supplied task or capability fields are ignored. The server refuses an unauthenticated non-loopback bind.

Main and Worker use the same trusted Pi Model Plane. Pi runs in a bubblewrap mount namespace with provider state and its session directory, but no Principal workspace, Controller state, or arbitrary project extension. Built-in tools, project extensions, skills, and context files are disabled; only the fixed Runtime extensions under `src/runtime` are loaded. The Pi extension reaches a Runtime-owned Unix socket with a per-session token. Runtime binds Worker tokens to a durable task, worker, Principal, and server-created ExecutionContext. `worker_exec` and workspace read/write/edit/mkdir/remove/list/stat tools all run through TaskService's Principal ExecutionBackend. Owner and Guest therefore use the same Pi and execution path; the backend selects the trusted Principal UID/GID and checks the persisted workspace/capability boundary. Pi 0.86.1 turns settle on `agent_settled`, after retries, compaction, and queued continuations.

Guest Task execution is controlled by `guest.enabled` and defaults to disabled when omitted. Enabling it requires the Agent Home container to run as system root inside its rootless Podman user namespace with `NET_ADMIN`; Runtime assigns persistent per-Principal UIDs, runs Owner and Guest Execution Plane commands through the compiled `agent-home-guest-exec` helper, and applies UID-scoped nftables egress rules to Guest IDs. Owner and Guest project/home/cache data live under `/state/principals/<principal-id>`. The state volume is mounted without Podman's `:U` ownership rewrite so per-Principal ownership survives restarts and backups. Run `pnpm test:guest-isolation` against a running, freshly rebuilt Agent Home container to verify OS UID/file/network isolation on the host's Podman setup.

Pi owns the provider/model catalog and the current default in `PI_CODING_AGENT_DIR/settings.json` (default `/state/model/pi/agent/settings.json`). This directory is owned by the dedicated Model Plane UID (10002); Runtime migrates the former `/state/home/.pi/agent` data once. Pi reads and refreshes provider credentials only inside its Model Plane namespace. Owner and Guest execution UIDs cannot traverse the Model Plane directory and never receive auth through environment variables, temporary copies, or tool context. The Gateway's owner-only `/model`, `/model list [provider]`, and `/model set <provider> <model>` commands query Pi settings through `podman exec`; switching a model updates this Model Plane state and hot-switches active Pi sessions through Runtime control without restarting Runtime. `scripts/pi-provider-onboarding.sh` and `scripts/pi-login.sh` target the configured Model Plane directory. Configure Main's optional conversational style in `agent.persona`; it is not passed to Workers, and it cannot change Runtime authorization or safety rules.

### Remote Pi Login

`scripts/pi-login.sh` needs a real TTY because Pi's `/login` flow is interactive. The SnowLuma noVNC endpoint is not a Pi terminal; it only exposes SnowLuma's QQ desktop. Use any authenticated SSH session to the host instead of exposing a web terminal:

```bash
ssh -tt <host-user>@<host> 'cd /home/lemonjuice/Projects/agent-home && ./scripts/pi-login.sh'
```

Inside Pi, run `/login`, choose `openai-codex`, and complete the browser authorization. The credential is written into the existing `agent-home-default-state` volume at `/state/model/pi/agent/auth.json`; no image rebuild or container recreation is needed.

## Tests

Tests use in-memory SQLite and narrow test doubles only at service boundaries. Production code retains real OneBot, Podman, and Pi paths. The test suite covers namespaced IDs, direct command bypass, wake policy, durable ingress deduplication, per-conversation Main queue ordering, outbound intent replay, authorization attenuation, scope isolation, worker questions/answers, cancellation, writer locks, recovery, and artifact path safety. CI runs typecheck, build, tests, shell syntax, and whitespace checks.
