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

  # Select half the physical cores, retaining their available SMT siblings. Intersect with
  # the caller's affinity so a build inside a restricted CPU set never broadens it.
  jobs=1
  cpus=
  if command -v lscpu >/dev/null 2>&1 && command -v taskset >/dev/null 2>&1 && [ -r /proc/self/status ]; then
    allowed=$(awk '/^Cpus_allowed_list:/ { print $2 }' /proc/self/status)
    budget=$(lscpu -p=CPU,CORE,SOCKET,ONLINE | awk -F, -v allowed="$allowed" '
      BEGIN { n=0 }
      function available(cpu, i, count, ranges, bounds) {
        count=split(allowed, ranges, ",")
        for (i=1; i<=count; i++) {
          split(ranges[i], bounds, "-")
          if (cpu >= bounds[1] && cpu <= (bounds[2] == "" ? bounds[1] : bounds[2])) return 1
        }
        return 0
      }
      !/^#/ && $4 != "N" {
        key=$3 ":" $2
        if (!(key in cores)) { cores[key]=1; physical++ }
        if (available($1)) { cpu[n]=$1; core[n]=key; n++ }
      }
      END {
        limit=int(physical/2); if (limit < 1) limit=1
        for (i=0; i<n; i++) {
          if (!(core[i] in chosen) && count < limit) { chosen[core[i]]=1; count++ }
          if (core[i] in chosen) { list=list (workers ? "," : "") cpu[i]; workers++ }
        }
        if (workers) print list "|" workers
      }')
    if [ -n "$budget" ]; then
      cpus=${budget%|*}
      jobs=${budget##*|}
    fi
  elif [ "$(uname -s)" = Darwin ]; then
    physical=$(sysctl -n hw.physicalcpu 2>/dev/null || echo 1)
    jobs=$((physical / 2))
    [ "$jobs" -ge 1 ] || jobs=1
  fi
  [ "$jobs" -le 16 ] || jobs=16
  case ${CMAKE_BUILD_PARALLEL_LEVEL:-} in
    '' | *[!0-9]* | 0) ;;
    *) [ "$jobs" -le "$CMAKE_BUILD_PARALLEL_LEVEL" ] || jobs=$CMAKE_BUILD_PARALLEL_LEVEL ;;
  esac
  CMAKE_BUILD_PARALLEL_LEVEL=$jobs
  OMP_NUM_THREADS=1
  export CMAKE_BUILD_PARALLEL_LEVEL OMP_NUM_THREADS
  if [ -n "$cpus" ]; then
    # Configure, code generation and link steps inherit the same CPU affinity as compilation.
    taskset -pc "$cpus" "$$" >/dev/null
  fi
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
