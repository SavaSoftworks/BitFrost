#!/bin/sh
# Copyright (C) 2026 Nick Germaine
# SPDX-License-Identifier: GPL-3.0-only
#
# BitFrost is free software: you can share and change it under the GNU General
# Public License, version 3 only. It comes with no warranty. See LICENSE.

# Quick checks before sending a change: the shell scripts, then the TUI build
# and its tests when this machine has cmake and a C++ compiler. Anything
# missing is skipped with a note, so the rest still runs.

main() {
  set -eu

  cd "$(dirname "$0")/.."

  failed=0

  echo "Shell scripts"
  for script in release/build.sh release/build-tui.sh release/check.sh release/install.sh plugins/bitfrost/bin/bitfrostd; do
    if sh -n "$script"; then
      ok "$script"
    else
      bad "$script (sh -n)"
    fi
  done
  if command -v shellcheck >/dev/null 2>&1; then
    if shellcheck release/build.sh release/build-tui.sh release/check.sh release/install.sh plugins/bitfrost/bin/bitfrostd; then
      ok "shellcheck"
    else
      bad "shellcheck"
    fi
  else
    skip "shellcheck (not installed)"
  fi

  echo "TUI"
  if [ ! -f tui/CMakeLists.txt ]; then
    skip "no TUI sources in this checkout"
  elif ! command -v cmake >/dev/null 2>&1; then
    skip "cmake not installed"
  elif ! command -v c++ >/dev/null 2>&1 && ! command -v g++ >/dev/null 2>&1 && ! command -v clang++ >/dev/null 2>&1; then
    skip "no C++ compiler"
  else
    if ./release/build-tui.sh && ctest --test-dir tui/build --output-on-failure; then
      ok "build and ctest"
    else
      bad "build and ctest"
    fi
  fi

  if [ "$failed" -eq 0 ]; then
    echo "All checks passed"
  else
    echo "$failed check(s) failed"
    exit 1
  fi
}

ok() { printf '  ok   %s\n' "$1"; }
skip() { printf '  skip %s\n' "$1"; }
bad() { printf '  FAIL %s\n' "$1"; failed=$((failed + 1)); }

main "$@"
