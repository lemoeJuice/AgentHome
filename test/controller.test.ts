import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GatewayState } from "../src/gateway/state.js";
import { PodmanController } from "../src/controller.js";
import type { AppConfig } from "../src/config.js";
import type { ControllerEventEnvelope } from "../src/shared/types.js";
import type { Logger } from "../src/shared/logger.js";

const logger = { child: () => logger, info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger;

test("Controller uses a durable outbox and reconnects the exec stream", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-home-controller-"));
  const podman = join(root, "podman");
  await writeFile(podman, `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == inspect ]]; then
  if [[ "$*" == *"{{json .}}"* ]]; then printf '%s\\n' '{"HostConfig":{"Privileged":false,"PidMode":"","NetworkMode":"bridge"},"Mounts":[{"Type":"volume","Name":"volume","Source":"volume","Destination":"/state"}],"NetworkSettings":{"Networks":{"agent-home-net":{}}}}'
  else printf 'true\\n'; fi
  exit 0
fi
if [[ "\${1:-}" == exec ]]; then
  if [[ " $* " == *" control ping "* ]]; then exit 0; fi
  while IFS= read -r line; do
    if [[ "$line" == *'"type":"hello"'* ]]; then printf '%s\\n' '{"type":"hello_ack","status":"ready"}';
    else
      [[ "$line" =~ \\\"eventId\\\":\\\"([^\\\"]+)\\\" ]] || exit 1
      event_id="\${BASH_REMATCH[1]}"
      printf '{"eventId":"%s","status":"accepted","receivedAt":"now"}\\n' "$event_id"
      exit 0
    fi
  done
fi
`, { mode: 0o700 });
  await chmod(podman, 0o700);
  const config = { instanceId: "test", owner: { platform: "qq", accountId: "a", userId: "u" }, paths: { gatewayState: join(root, "gateway.sqlite"), pluginData: root, backupDir: root, stateRoot: root, runtimeSocket: join(root, "socket") }, snowluma: { accountId: "a", endpoint: "ws://localhost", apiEndpoint: "http://localhost", accessTokenEnv: "TOKEN", reverseWebSocketPath: "/ws", reconnectMs: 10, requestTimeoutMs: 10 }, chat: { global: { commandRequireMention: false, naturalLanguageMode: "explicit_wake" as const }, qq: { commandRequireMention: false, naturalLanguageMode: "explicit_wake" as const }, conversationOverrides: {} }, runtime: { maxInFlight: 2, maxWorkers: 1, maxArtifactBytes: 1000, piCommand: "pi", piTimeoutMs: 1000 }, plugins: { enabled: [] }, logging: { level: "error" as const } } as AppConfig;
  let state = new GatewayState(config.paths.gatewayState);
  const replayEvent = { protocolVersion: 1, eventId: "replay-1", instanceId: "test", type: "chat.message", occurredAt: new Date().toISOString(), source: { platform: "qq", accountId: "a", adapter: "test" }, payload: {} } as ControllerEventEnvelope;
  state.store.run("INSERT INTO controller_outbox(event_id,envelope_json,status,attempts,created_at,updated_at) VALUES (?,?,?,?,?,?)", replayEvent.eventId, JSON.stringify(replayEvent), "SENT", 1, new Date().toISOString(), new Date().toISOString());
  state.close();
  state = new GatewayState(config.paths.gatewayState);
  const controller = new PodmanController(config, state, logger, { podmanCommand: podman, containerName: "container", image: "image", volume: "volume" });
  await controller.start();
  assert.equal(state.store.get("SELECT 1 AS found FROM controller_outbox WHERE event_id='replay-1'"), undefined);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const event = { protocolVersion: 1, eventId: "evt-1", instanceId: "test", type: "chat.message", occurredAt: new Date().toISOString(), source: { platform: "qq", accountId: "a", adapter: "test" }, payload: {} } as ControllerEventEnvelope;
  await controller.deliver(event);
  assert.equal(state.store.get("SELECT 1 AS found FROM controller_outbox WHERE event_id='evt-1'"), undefined);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const second = { ...event, eventId: "evt-2" };
  await controller.deliver(second);
  assert.equal(state.store.get("SELECT 1 AS found FROM controller_outbox WHERE event_id='evt-2'"), undefined);
  await controller.stop(); state.close(); await rm(root, { recursive: true, force: true });
});

test("Controller rejects unsafe topology on an existing container", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-home-controller-topology-"));
  const podman = join(root, "podman");
  await writeFile(podman, `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == inspect ]]; then
  if [[ "$*" == *"{{json .}}"* ]]; then printf '%s\\n' '{"HostConfig":{"Privileged":true,"PidMode":"","NetworkMode":"bridge"},"Mounts":[],"NetworkSettings":{"Networks":{"agent-home-net":{}}}}'
  else printf 'true\\n'; fi
  exit 0
fi
`, { mode: 0o700 });
  await chmod(podman, 0o700);
  const config = { instanceId: "topology", paths: { gatewayState: join(root, "gateway.sqlite"), pluginData: root, backupDir: root, stateRoot: root, runtimeSocket: join(root, "socket") }, snowluma: { accountId: "a", endpoint: "ws://localhost", apiEndpoint: "http://localhost", accessTokenEnv: "TOKEN", reverseWebSocketPath: "/ws", reconnectMs: 10, requestTimeoutMs: 10 }, runtime: { maxInFlight: 2, maxWorkers: 1, maxArtifactBytes: 1000, piCommand: "pi", piTimeoutMs: 1000 }, plugins: { enabled: [] }, logging: { level: "error" as const } } as AppConfig;
  const state = new GatewayState(config.paths.gatewayState);
  const controller = new PodmanController(config, state, logger, { podmanCommand: podman, containerName: "container", image: "image", volume: "volume" });
  await assert.rejects(controller.start(), /CONTAINER_PRIVILEGED_FORBIDDEN/);
  state.close();
  await rm(root, { recursive: true, force: true });
});

test("Controller rejects an existing container with the wrong state volume or network", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-home-controller-volume-network-"));
  const podman = join(root, "podman");
  await writeFile(podman, `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == inspect ]]; then
  if [[ "$*" == *"{{json .}}"* ]]; then printf '%s\\n' '{"HostConfig":{"Privileged":false,"PidMode":"","NetworkMode":"bridge"},"Mounts":[{"Type":"volume","Name":"wrong-volume","Source":"wrong-volume","Destination":"/state"}],"NetworkSettings":{"Networks":{"wrong-network":{}}}}'
  else printf 'true\\n'; fi
  exit 0
fi
`, { mode: 0o700 });
  await chmod(podman, 0o700);
  const config = { instanceId: "topology-mismatch", paths: { gatewayState: join(root, "gateway.sqlite"), pluginData: root, backupDir: root, stateRoot: root, runtimeSocket: join(root, "socket") }, snowluma: { accountId: "a", endpoint: "ws://localhost", apiEndpoint: "http://localhost", reverseWebSocketPath: "/ws", reconnectMs: 10, requestTimeoutMs: 10 }, runtime: { maxInFlight: 2, maxWorkers: 1, maxArtifactBytes: 1000, piCommand: "pi", piTimeoutMs: 1000 }, plugins: { enabled: [] }, logging: { level: "error" as const } } as AppConfig;
  const state = new GatewayState(config.paths.gatewayState);
  const controller = new PodmanController(config, state, logger, { podmanCommand: podman, containerName: "container", image: "image", volume: "volume" });
  await assert.rejects(controller.start(), /CONTAINER_STATE_VOLUME_MISMATCH|CONTAINER_NETWORK_TOPOLOGY_FORBIDDEN/);
  state.close();
  await rm(root, { recursive: true, force: true });
});
