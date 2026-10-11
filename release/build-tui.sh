#!/bin/sh
# Copyright (C) 2026 Nick Germaine
# SPDX-License-Identifier: GPL-3.0-only
#
# BitFrost is free software: you can share and change it under the GNU General
# Public License, version 3 only. It comes with no warranty. See LICENSE.

# Builds the TUI for this machine into tui/build/bitfrost-tui.
# Options: --static, an output path to also copy the binary to, and anything
# after -- goes straight to cmake.

main() {
  set -eu

  cd "$(dirname "$0")/.."

  static=OFF
  out=
  while [ $# -gt 0 ]; do
    case $1 in
      --static) static=ON; shift ;;
      --) shift; break ;;
      -h | --help) usage; exit 0 ;;
      -*) echo "build-tui.sh: unknown option: $1" >&2; exit 1 ;;
      *)
        if [ -n "$out" ]; then
          echo "build-tui.sh: two output paths: $out and $1" >&2
          exit 1
        fi
        out=$1
        shift
        ;;
    esac
  done

  . ./release/build-cpu.sh
  cmake -S tui -B tui/build -DCMAKE_BUILD_TYPE=Release "-DBITFROST_STATIC=$static" "$@"
  cmake --build tui/build --parallel "$jobs"

  [ -f tui/build/bitfrost-tui ] || { echo "build-tui.sh: no tui/build/bitfrost-tui came out" >&2; exit 1; }
  if [ -n "$out" ]; then
    mkdir -p "$(dirname "$out")"
    cp tui/build/bitfrost-tui "$out"
    chmod 755 "$out"
    echo "build-tui.sh: tui/build/bitfrost-tui and $out"
  else
    echo "build-tui.sh: tui/build/bitfrost-tui"
  fi
}

usage() {
  cat <<'EOF2'
Builds the BitFrost TUI for this machine into tui/build/bitfrost-tui.

  build-tui.sh [--static] [OUTPUT] [-- cmake options]

  --static          link as much as possible into the binary (release builds)
  OUTPUT            also copy the binary there
  -- options        more options for cmake, e.g. -DCMAKE_OSX_ARCHITECTURES=arm64;x86_64
EOF2
}

main "$@"
