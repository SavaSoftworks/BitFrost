#!/bin/sh
# Copyright (C) 2026 Nick Germaine; SPDX-License-Identifier: GPL-3.0-only
# Shared by local checks and CI. Keep each component in its release Alpine image.
set -eu
cd "$(dirname "$0")/.."
component=${1:-all}
case $component in
  all | migrations | tui) ;;
  *) echo 'Usage: release/check-linux.sh [all|migrations|tui]' >&2; exit 2 ;;
esac

# The host launches this same script in a container with isolated build caches.
if [ "${2:-}" = --container ] && [ $# -eq 2 ] && [ "$component" != all ]; then
  case $component in migrations) build_path=plugins/bitfrost/migrations/build ;; tui) build_path=tui/build ;; esac
  # shellcheck disable=SC2317,SC2329 # Invoked indirectly by the EXIT trap (older/newer ShellCheck).
  cleanup() {
    status=$?
    trap - EXIT
    chown -R "$OWNER" dist "$build_path" 2>/dev/null || :
    exit "$status"
  }
  trap cleanup EXIT
  case $component in
    migrations)
      apk add --no-cache build-base gnucobol sqlite-dev curl unzip file m4 tzdata nodejs-current util-linux
      ./release/build-migrations.sh --static dist/bitfrost-migrate
      file dist/bitfrost-migrate
      file dist/bitfrost-migrate | grep -Eq 'statically linked|static-pie linked'
      BITFROST_MIGRATOR=/src/dist/bitfrost-migrate node --test --disable-warning=ExperimentalWarning \
        plugins/bitfrost/daemon/test/migration.spec.ts plugins/bitfrost/daemon/test/store.spec.ts
      ;;
    tui)
      apk add --no-cache g++ cmake make linux-headers python3 nodejs-current file util-linux
      ./release/build-tui.sh --static dist/bitfrost-tui
      ctest --test-dir tui/build --output-on-failure
      version=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' plugins/bitfrost/.claude-plugin/plugin.json)
      ./dist/bitfrost-tui --version | grep -qF "$version"
      ./dist/bitfrost-tui --selftest
      file dist/bitfrost-tui | grep -Eq 'statically linked|static-pie linked'
      ;;
  esac
  exit 0
fi
[ $# -le 1 ] || { echo 'check-linux.sh: unexpected arguments' >&2; exit 2; }
command -v docker >/dev/null 2>&1 || { echo 'check-linux.sh: Docker is required for Linux release checks' >&2; exit 1; }
docker info >/dev/null 2>&1 || {
  echo 'check-linux.sh: cannot access Docker. Start the daemon and give your user access to it.' >&2
  exit 1
}
. ./release/build-cpu.sh

check_component() {
  part=$1
  case $part in
    migrations) image=alpine:3.24; build_path=plugins/bitfrost/migrations/build; binary=bitfrost-migrate ;;
    tui) image=alpine:3.22; build_path=tui/build; binary=bitfrost-tui ;;
  esac
  # Native CMake/runtime caches cannot be reused inside musl containers.
  # Sources are read-only; only this component's ignored build cache is writable.
  cache=$PWD/dist/check-linux/$part
  mkdir -p "$cache/build" "$cache/dist" "$build_path"
  set -- --cpus "$jobs"
  if [ -n "$cpus" ]; then set -- "$@" --cpuset-cpus "$cpus"; fi
  echo "Linux release checks: $part ($image, $(uname -m))"
  docker run --rm "$@" \
    --volume "$PWD:/src:ro" --workdir /src \
    --volume "$cache/build:/src/$build_path" --volume "$cache/dist:/src/dist" \
    --env "OWNER=$(id -u):$(id -g)" --env "CMAKE_BUILD_PARALLEL_LEVEL=$jobs" \
    "$image" sh ./release/check-linux.sh "$part" --container
  # CI's artifact naming step consumes this path, also convenient locally.
  cp "$cache/dist/$binary" "dist/$binary"
}

if [ "$component" = all ]; then
  check_component migrations
  check_component tui
else
  check_component "$component"
fi
