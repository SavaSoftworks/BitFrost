#!/bin/sh
# Copyright (C) 2026 Nick Germaine; SPDX-License-Identifier: GPL-3.0-only
# Check the release migration engine directly, without a container daemon.
set -eu
cd "$(dirname "$0")/.."
case ${1:-} in
  '' | --preflight) [ $# -le 1 ] || exit 2 ;;
  *) echo 'Usage: release/check-migrations.sh [--preflight]' >&2; exit 2 ;;
esac

require() {
  command -v "$1" >/dev/null 2>&1 || { echo "check-migrations.sh: required command missing: $1" >&2; exit 1; }
}
for command in node cobc make m4 curl tar unzip file; do require "$command"; done
case $(uname -s) in
  Linux)
    compiler=${BITFROST_MUSL_CC:-musl-gcc}
    command -v "$compiler" >/dev/null 2>&1 || {
      echo 'check-migrations.sh: install a musl compiler (musl-tools on Debian/Ubuntu), or set BITFROST_MUSL_CC to one.' >&2
      exit 1
    }
    cache=$PWD/dist/check-migrations/linux-$(uname -m)
    ;;
  Darwin)
    compiler=${CC:-cc}
    for command in "$compiler" lipo otool; do require "$command"; done
    cache=$PWD/dist/check-migrations/darwin-universal
    ;;
  *) echo 'check-migrations.sh: Linux and macOS are supported' >&2; exit 1 ;;
esac
for zone in America/New_York America/Halifax Australia/Lord_Howe Pacific/Chatham; do
  [ -r "/usr/share/zoneinfo/$zone" ] || { echo 'check-migrations.sh: install tzdata for the timezone regression tests' >&2; exit 1; }
done
# Dependency builds, COBOL code generation and linking share the CPU budget.
. ./release/build-cpu.sh
if [ "$(uname -s)" = Linux ]; then
  # Fail rather than accidentally testing a glibc binary with a custom compiler.
  printf '#include <features.h>\n#ifdef __GLIBC__\n#error A_musl_C_compiler_is_required\n#endif\n' |
    "$compiler" -E -x c - >/dev/null
fi
[ "${1:-}" != --preflight ] || exit 0
mkdir -p "$cache"
binary=$cache/bitfrost-migrate
echo "Release migration build and tests: $(uname -s) $(uname -m), $compiler"
CC=$compiler ./release/build-migrations.sh --static --build-dir "$cache/build" "$binary"
case $(uname -s) in
  Linux)
    file "$binary"
    file "$binary" | grep -Eq 'statically linked|static-pie linked'
    ;;
  Darwin)
    lipo -verify_arch arm64 x86_64 "$binary"
    if otool -L "$binary" | grep -E '/opt/homebrew|/usr/local|/src/'; then exit 1; fi
    ;;
esac
BITFROST_MIGRATOR=$binary node --test --disable-warning=ExperimentalWarning \
  plugins/bitfrost/daemon/test/migration.spec.ts plugins/bitfrost/daemon/test/store.spec.ts
echo 'Release migration checks passed. CI also checks its platform toolchains and other architectures.'
