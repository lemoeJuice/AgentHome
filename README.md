# Agent Home

Agent Home is a durable QQ-connected Agent runtime built around Rootless Podman, OneBot/SnowLuma, and Pi. The host Bot Gateway owns platform ingress, routing, load-time plugins, and the Controller. The Agent Home container owns Runtime, Main/Worker Pi sessions, tasks, memory, artifacts, and canonical `/state`.

## Quick Start

```bash
cp config.example.json config/agent-home.json
# edit owner.userId and SnowLuma endpoints
pnpm install
./scripts/setup.sh
./scripts/doctor.sh
./scripts/start.sh
```

`setup.sh` requires Node 22.5+, npm, and rootless Podman. It creates the named state volume and builds the image. Secrets are supplied through environment variables or the container bootstrap stdin command, never process arguments.

Useful commands:

```bash
./scripts/build.sh
./scripts/start.sh
./scripts/stop.sh
./scripts/restart.sh
./scripts/status.sh
./scripts/doctor.sh
./scripts/test.sh
./scripts/backup.sh
./scripts/restore.sh backups/<backup-directory>
```

## Configuration

`config.example.json` is a committed template. `config/agent-home.json` is deployment configuration and is ignored by Git. `SNOWLUMA_ACCESS_TOKEN` is a secret environment variable; inside Agent Home it may also be written by `agent-home bootstrap --stdin` to `/state/secrets/`.

The common chat model always namespaces platform, account, conversation, thread, and message IDs. `null` means a supported field has no value; `NOT_IMPLEMENTED` is a structured unsupported-field sentinel.

## Runtime Boundaries

Business ingress follows:

```text
SnowLuma → QQChatPlatformAdapter → Router → Controller
→ podman exec -i control stream → container-local Unix socket
→ durable SQLite ingress → Runtime/Main
```

Direct plugin commands bypass Main. Agent outbound messages use the in-container SnowLuma capability. Worker files must be registered as `ArtifactRef` objects before delivery; raw local paths are never passed to QQ.

## External Integrations

The production OneBot adapter uses forward WebSocket events and HTTP actions (`send_msg`, `get_msg`, `get_group_msg_history`, `get_file`, and `get_login_info`). Pi is isolated in `src/runtime/pi.ts` and uses its real CLI print/session interface. Live verification requires a configured SnowLuma endpoint/token, a Pi installation, and rootless Podman.

Small artifacts are transferred through OneBot's `base64://` file reference. Larger files require `AGENT_ARTIFACT_PUBLIC_BASE_URL` pointing to a scoped, short-lived upload gateway reachable by SnowLuma. No unrestricted Agent Home filesystem URL is exposed.

## Tests

Tests use in-memory SQLite and narrow test doubles only at service boundaries. Production code retains real OneBot, Podman, and Pi paths. The test suite covers namespaced IDs, direct command bypass, wake policy, durable ingress deduplication, authorization attenuation, scope isolation, worker questions/answers, cancellation, writer locks, recovery, and artifact path safety.
