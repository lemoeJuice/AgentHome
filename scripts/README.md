# Script layout

Deployment and lifecycle commands remain at this directory's top level so the
documented `./scripts/<command>.sh` interface stays short and stable.

- Top-level scripts: deploy/setup, lifecycle, backup/restore, auth, build, and diagnostics.
- `tests/`: unit-test wrapper, real integration checks, and Principal isolation checks.
- `qq/`: helper programs used by the QQ QR login workflow.
- `lib.sh`: shared host deployment configuration and Podman selection.

`deploy.sh` finishes setup and then enters `run.sh`'s foreground mode. Logs are
kept under `.agent-home/runtime-state/`. Press Ctrl+C or run `stop.sh` to stop
Gateway, Agent Home, and Proxy Relay; the SnowLuma container is intentionally
left running.
