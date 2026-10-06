#!/bin/sh
# Copyright (C) 2026 Nick Germaine
# SPDX-License-Identifier: GPL-3.0-only
#
# BitFrost is free software: you can share and change it under the GNU General
# Public License, version 3 only. It comes with no warranty. See LICENSE.

# Builds dist/bitfrost-<version>.tar.gz and its .sha256 for install.sh.
set -eu

cd "$(dirname "$0")/.."
version=$(node -p 'JSON.parse(require("fs").readFileSync("plugins/bitfrost/.claude-plugin/plugin.json", "utf8")).version')
name=bitfrost-$version
out=dist/$name

rm -rf "$out" "dist/$name.tar.gz" "dist/$name.tar.gz.sha256"
mkdir -p "$out/.claude-plugin" "$out/plugins"
cp LICENSE README.md "$out/"
cp -R plugins/bitfrost "$out/plugins/"
rm -rf "$out/plugins/bitfrost/daemon/test" \
  "$out/plugins/bitfrost/hooks/register.test.ts" \
  "$out/plugins/bitfrost/.claude-plugin/types" \
  "$out/plugins/bitfrost/tsconfig.json"

node -e '
  const fs = require("fs")
  const m = JSON.parse(fs.readFileSync(".claude-plugin/marketplace.json", "utf8"))
  m.plugins = m.plugins.filter((p) => p.name === "bitfrost")
  if (m.plugins.length !== 1) throw new Error("marketplace.json has no bitfrost plugin")
  fs.writeFileSync(process.argv[1], JSON.stringify(m, null, 2) + "\n")
' "$out/.claude-plugin/marketplace.json"

# Fixed order, owner and times make the build repeatable.
mtime=$(git log -1 --format=%cI 2>/dev/null || echo 2026-01-01T00:00:00Z)
# No pipe: sh would only see gzip's exit status.
tar --sort=name --owner=0 --group=0 --numeric-owner --mtime="$mtime" \
  -C dist -cf "dist/$name.tar" "$name"
gzip -n "dist/$name.tar"
(cd dist && sha256sum "$name.tar.gz" >"$name.tar.gz.sha256")
rm -rf "$out"
echo "$version"
