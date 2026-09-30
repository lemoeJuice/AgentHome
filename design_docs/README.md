# Agent Home Design — Final MVP Architecture Baseline

Canonical top-level document:
- `AGENT_HOME_DESIGN.md`

Autonomous implementation instructions:
- `AGENT.md`

Recommended reading order:
1. `AGENT.md`
2. `AGENT_HOME_DESIGN.md`
3. `MEMORY_SYSTEM_DESIGN.md`
4. `AGENT_HOME_CONTAINER_CONTROL_DESIGN.md`
5. `MAIN_WORKER_ORCHESTRATION_DESIGN.md`
6. `EXTERNAL_PLUGIN_COMMAND_DESIGN.md`
7. `TASK_RUNTIME_DESIGN.md`
8. `AUTHORIZATION_CAPABILITY_DESIGN.md`
9. `ARTIFACT_FILE_DESIGN.md`
10. `PRINCIPAL_WORKSPACE_SYSTEM_ADMIN_DESIGN.md`
11. `UID_GID_MEMORY_DESIGN.md`

`PRINCIPAL_WORKSPACE_SYSTEM_ADMIN_DESIGN.md` and `UID_GID_MEMORY_DESIGN.md`
are the current identity/workspace/memory baselines. Older Guest sandbox and
role-based designs are historical where they differ from these documents.

Key current implementation choices:
- language: TypeScript + Node.js
- container baseline: Rootless Podman
- harness: Pi
- current chat platform: QQ
- current QQ transport: SnowLuma / OneBot
- only formal multi-backend abstraction: Chat Platform
- plugins: load-time Bot Gateway modules, not independent services

Implementation agents must use current real Pi and SnowLuma/OneBot documentation/API/source interfaces and complete real integrations. Mock-only adapters, placeholders, or TODO-only production integrations are not acceptable.

Chat Platform abstraction notes:
- common platform fields are normalized by adapters;
- `null` means supported-but-absent;
- `NOT_IMPLEMENTED` means unsupported by that platform;
- raw platform IDs are always namespaced by platform/account/conversation;
- cross-platform identity linking is explicit, while Conversation/Pi sessions remain separate.
