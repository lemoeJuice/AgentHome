#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
source "$ROOT_DIR/scripts/lib.sh"

fail() {
  printf 'Podman setup error: %s\n' "$1" >&2
  exit 2
}

configure_project_storage() {
  [[ -n "${CONTAINERS_STORAGE_CONF:-}" ]] && return
  local filesystem driver mount_program config_dir graphroot marker previous_driver
  config_dir="$ROOT_DIR/.agent-home/podman"
  mkdir -p "$config_dir"
  config_dir="$(realpath "$config_dir")"
  filesystem="$(stat -f -c '%T' "$ROOT_DIR" 2>/dev/null || true)"
  driver="${AGENT_HOME_PODMAN_STORAGE_DRIVER:-}"
  if [[ -z "$driver" ]]; then
    if [[ "$filesystem" == btrfs ]]; then
      driver=btrfs
    elif command -v fuse-overlayfs >/dev/null 2>&1; then
      driver=overlay
    else
      driver=vfs
    fi
  fi
  [[ "$driver" == btrfs || "$driver" == overlay || "$driver" == vfs ]] || fail "unsupported Podman storage driver: $driver"
  marker="$config_dir/storage-driver"
  previous_driver=""
  [[ -r "$marker" ]] && previous_driver="$(<"$marker")"
  graphroot="$config_dir/storage"
  if [[ -n "$previous_driver" && "$previous_driver" != "$driver" && -e "$graphroot" ]]; then
    graphroot="$config_dir/storage-$driver"
  fi
  graphroot="$(realpath -m "$graphroot")"
  mount_program=""
  if [[ "$driver" == overlay ]]; then
    mount_program="$(command -v fuse-overlayfs || true)"
    [[ -n "$mount_program" ]] || fail 'overlay storage requires fuse-overlayfs; install it or use a Btrfs-backed project directory'
  fi
  umask 077
  {
    printf '[storage]\n'
    printf 'driver = "%s"\n' "$driver"
    printf 'graphroot = "%s"\n' "$graphroot"
    if [[ "$driver" == overlay ]]; then
      printf '\n[storage.options]\n'
      printf 'mount_program = "%s"\n' "$mount_program"
    fi
  } >"$config_dir/storage.conf"
  printf '%s\n' "$driver" >"$marker"
  export CONTAINERS_STORAGE_CONF="$config_dir/storage.conf"
  printf 'configured rootless Podman storage: driver=%s graphroot=%s\n' "$driver" "$graphroot"
}

is_local_engine() {
  local candidate="$1"
  [[ -n "$candidate" && -x "$candidate" ]] || return 1
  "$candidate" info --format '{{.Host.Security.Rootless}}' >/dev/null 2>&1
}

run_privileged() {
  if [[ "$EUID" == 0 ]]; then
    "$@"
  elif command -v sudo >/dev/null; then
    if [[ -t 0 ]]; then
      sudo "$@"
    else
      sudo -n "$@" 2>/dev/null || fail 'sudo requires a password; rerun this setup from an interactive terminal'
    fi
  else
    fail 'root privileges are required to install Podman, but sudo is unavailable'
  fi
}

install_with_package_manager() {
  if command -v pacman >/dev/null; then
    printf '%s\n' 'Podman is missing or unusable; installing with pacman...'
    run_privileged pacman -S --needed --noconfirm podman
  elif command -v apt-get >/dev/null; then
    printf '%s\n' 'Podman is missing or unusable; installing with apt-get...'
    run_privileged env DEBIAN_FRONTEND=noninteractive apt-get update
    run_privileged env DEBIAN_FRONTEND=noninteractive apt-get install -y podman
  elif command -v dnf >/dev/null; then
    printf '%s\n' 'Podman is missing or unusable; installing with dnf...'
    run_privileged dnf install -y podman
  elif command -v yum >/dev/null; then
    printf '%s\n' 'Podman is missing or unusable; installing with yum...'
    run_privileged yum install -y podman
  elif command -v zypper >/dev/null; then
    printf '%s\n' 'Podman is missing or unusable; installing with zypper...'
    run_privileged zypper --non-interactive install podman
  elif command -v apk >/dev/null; then
    printf '%s\n' 'Podman is missing or unusable; installing with apk...'
    run_privileged apk add --no-cache podman
  else
    fail 'no supported package manager found; expected pacman, apt-get, dnf, yum, zypper, or apk'
  fi
}

PODMAN=""
configure_project_storage
if is_local_engine "$FIXED_PODMAN"; then
  PODMAN="$FIXED_PODMAN"
else
  SYSTEM_PODMAN="$(command -v podman || true)"
  if is_local_engine "$SYSTEM_PODMAN"; then PODMAN="$SYSTEM_PODMAN"; fi
fi

if [[ -z "$PODMAN" ]]; then
  install_with_package_manager
  SYSTEM_PODMAN="$(command -v podman || true)"
  is_local_engine "$SYSTEM_PODMAN" || fail 'Podman was installed, but its local rootless engine is not usable by the current user'
  PODMAN="$SYSTEM_PODMAN"
fi

ROOTLESS="$($PODMAN info --format '{{.Host.Security.Rootless}}')" || fail 'Podman local engine check failed'
[[ "$ROOTLESS" == true ]] || fail 'Podman must run rootless; do not run this setup through sudo'
export PODMAN_COMMAND="$PODMAN"
printf 'local rootless Podman ready: %s\n' "$PODMAN"
