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
if [[ "\${1:-}" == inspect ]]; then printf 'true\\n'; exit 0; fi
if [[ "\${1:-}" == exec ]]; then
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
  const state = new GatewayState(config.paths.gatewayState);
  const controller = new PodmanController(config, state, logger, { podmanCommand: podman, containerName: "container", image: "image", volume: "volume" });
  await controller.start();
  const event = { protocolVersion: 1, eventId: "evt-1", instanceId: "test", type: "chat.message", occurredAt: new Date().toISOString(), source: { platform: "qq", accountId: "a", adapter: "test" }, payload: {} } as ControllerEventEnvelope;
  await controller.deliver(event);
  assert.equal(state.store.get("SELECT 1 AS found FROM controller_outbox WHERE event_id='evt-1'"), undefined);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const second = { ...event, eventId: "evt-2" };
  await controller.deliver(second);
  assert.equal(state.store.get("SELECT 1 AS found FROM controller_outbox WHERE event_id='evt-2'"), undefined);
  await controller.stop(); state.close(); await rm(root, { recursive: true, force: true });
});
