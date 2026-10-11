#!/bin/sh
# Copyright (C) 2026 Nick Germaine; SPDX-License-Identifier: GPL-3.0-only
# Local checks. --native omits the additional release migration build.
set -eu
cd "$(dirname "$0")/.."

mode=${1:-all}
case $mode in
  all | --native | --style) [ $# -le 1 ] || exit 2 ;;
  *) echo 'Usage: release/check.sh [--native|--style]' >&2; exit 2 ;;
esac

require() {
  command -v "$1" >/dev/null 2>&1 || { echo "check.sh: required command missing: $1" >&2; exit 1; }
}
style() {
  require clang-format
  major=$(clang-format --version | sed -n 's/.*version \([0-9]*\).*/\1/p')
  [ "${major:-0}" -ge 23 ] || { echo 'check.sh: clang-format 23 or newer is required' >&2; exit 1; }
  find tui/src tui/tests \( -name '*.cpp' -o -name '*.hpp' \) -exec clang-format --dry-run --Werror {} +
}

echo 'C++ style'
style
[ "$mode" != --style ] || exit 0
for command in shellcheck node npm claude cobc cmake ctest python3; do require "$command"; done
if [ "$mode" = all ]; then
  ./release/check-migrations.sh --preflight
fi

echo 'Shell scripts'
for script in release/*.sh plugins/bitfrost/bin/bitfrostd; do sh -n "$script"; done
shellcheck release/*.sh plugins/bitfrost/bin/bitfrostd

echo 'Plugin validation, daemon, migration and plugin tests (native)'
claude plugin validate plugins/bitfrost
npm test
echo 'TUI build and terminal tests (native)'
./release/build-tui.sh
ctest --test-dir tui/build --output-on-failure

if [ "$mode" = --native ]; then
  echo 'Native checks passed. Release migration builds and other platforms were not checked.'
else
  ./release/check-migrations.sh
  echo 'Local checks passed. CI also checks the Alpine TUI, other architectures and release installation.'
fi
