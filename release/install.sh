#!/bin/sh
# Copyright (C) 2026 Nick Germaine
# SPDX-License-Identifier: GPL-3.0-only
#
# BitFrost is free software: you can share and change it under the GNU General
# Public License, version 3 only. It comes with no warranty. See LICENSE.

# Installs or updates BitFrost from a GitHub release. Run it again to update.
# Options: --version X.Y.Z, --from FILE, --no-plugin.

# All in main() so a cut-off download never runs half a script.
main() {
  set -eu

  REPO=${BITFROST_REPO:-SavaSoftworks/BitFrost}
  DATA=${XDG_DATA_HOME:-$HOME/.local/share}/bitfrost
  BIN_DIR=${BITFROST_BIN_DIR:-$HOME/.local/bin}
  CONFIG=${XDG_CONFIG_HOME:-$HOME/.config}/bitfrost/config.json

  version=
  from=
  plugin=1
  while [ $# -gt 0 ]; do
    case $1 in
      --version) [ $# -ge 2 ] || die "--version needs a value"; version=${2#v}; shift 2 ;;
      --from) [ $# -ge 2 ] || die "--from needs a file"; from=$2; shift 2 ;;
      --no-plugin) plugin=; shift ;;
      -h | --help) usage; exit 0 ;;
      *) die "unknown option: $1" ;;
    esac
  done

  need tar
  mkdir -p "$DATA/versions"
  tmp=$(mktemp -d "$DATA/.install.XXXXXX")
  trap 'rm -rf "$tmp"' EXIT INT TERM

  if [ -n "$from" ]; then
    [ -f "$from" ] || die "no such file: $from"
    base=${from##*/}
    from_version=${base#bitfrost-}
    from_version=${from_version%.tar.gz}
    [ -z "$version" ] || [ "$version" = "$from_version" ] || die "$base is not version $version"
    version=$from_version
    check_version "$version"
    cp "$from" "$tmp/$base"
    if [ -f "$from.sha256" ]; then
      cp "$from.sha256" "$tmp/$base.sha256"
      verify "$tmp" "$base"
    else
      say "no $base.sha256 next to it, skipping the checksum"
    fi
  else
    need curl
    if [ -z "$version" ]; then
      url=$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest") ||
        die "can't reach github.com/$REPO"
      version=${url##*/}
      version=${version#v}
    fi
    check_version "$version"
    base=bitfrost-$version.tar.gz
    if [ ! -d "$DATA/versions/$version" ]; then
      say "downloading $base"
      dl="https://github.com/$REPO/releases/download/v$version"
      curl -fsSL -o "$tmp/$base" "$dl/$base" || die "can't download $dl/$base"
      curl -fsSL -o "$tmp/$base.sha256" "$dl/$base.sha256" || die "can't download $dl/$base.sha256"
      verify "$tmp" "$base"
    fi
  fi

  if [ -d "$DATA/versions/$version" ]; then
    say "bitfrost $version is already unpacked"
  else
    mkdir "$tmp/x"
    tar -xzf "$tmp/$base" -C "$tmp/x"
    root=$tmp/x/bitfrost-$version
    manifest=$root/plugins/bitfrost/.claude-plugin/plugin.json
    [ -f "$manifest" ] || die "$base doesn't look like a bitfrost release"
    inside=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$manifest")
    [ "$inside" = "$version" ] || die "$base holds version '$inside', not $version"
    # A rename, so a version folder is never half there.
    mv "$root" "$DATA/versions/$version"
  fi

  previous=
  if [ -L "$DATA/current" ]; then
    previous=$(readlink "$DATA/current")
    previous=${previous##*/}
  fi
  # Only replace a link. mv would put the new link inside a real folder.
  [ ! -e "$DATA/current" ] || [ -L "$DATA/current" ] || die "$DATA/current isn't a link; move it away and run this again"
  ln -s "versions/$version" "$tmp/current"
  swap "$tmp/current" "$DATA/current"

  # Keep the previous version: a helper started from it may still run.
  for dir in "$DATA/versions"/*; do
    [ -d "$dir" ] || continue
    v=${dir##*/}
    [ "$v" = "$version" ] || [ "$v" = "$previous" ] || rm -rf "$dir"
  done

  mkdir -p "$BIN_DIR"
  link=$BIN_DIR/bitfrost
  [ ! -e "$link" ] || [ -L "$link" ] || die "$link exists and isn't a link; move it away and run this again"
  ln -sfn "$DATA/current/plugins/bitfrost/bin/bitfrostd" "$link"

  profile=${CLAUDE_CONFIG_DIR:-'~/.claude'}
  if [ ! -e "$CONFIG" ]; then
    mkdir -p "${CONFIG%/*}"
    printf '{\n  "allowedProfiles": ["%s"]\n}\n' "$(json_escape "$profile")" >"$CONFIG"
    say "wrote $CONFIG"
  elif [ -n "${CLAUDE_CONFIG_DIR:-}" ] && ! listed "$CLAUDE_CONFIG_DIR"; then
    say "warning: add \"$CLAUDE_CONFIG_DIR\" to allowedProfiles in $CONFIG, or that profile gets no subagents"
  fi

  if [ -n "$plugin" ]; then
    install_plugin
  fi

  if ! out=$("$link" socket 2>&1); then
    say "warning: $out"
  fi

  if [ "$previous" = "$version" ]; then
    say "bitfrost $version is installed"
  elif [ -n "$previous" ]; then
    say "updated bitfrost $previous -> $version"
  else
    say "installed bitfrost $version"
  fi
  case :$PATH: in
    *:"$BIN_DIR":*) ;;
    *) say "add $BIN_DIR to your PATH to use the bitfrost command" ;;
  esac
  if [ -z "$previous" ]; then
    say "Codex and ZCode work once installed and signed in. For GLM, also run once:"
    cmd "bitfrost setup zcode"
    say "opencode, Oh My Pi and Gemini CLI stay off until turned on in $CONFIG"
    say "setup for each app: https://github.com/$REPO/blob/main/GUIDE.md#setup"
  fi
  say "new Claude sessions use this version"
}

install_plugin() {
  claude=$(find_claude) || {
    say "Claude Code not found. To add the plugin yourself, run:"
    cmd "claude plugin marketplace add $DATA/current"
    cmd "claude plugin install bitfrost@bitfrost --scope user"
    return 0
  }
  "$claude" plugin marketplace add "$DATA/current" || die "claude plugin marketplace add failed"
  "$claude" plugin install bitfrost@bitfrost --scope user || die "claude plugin install failed"
  if [ -n "$previous" ] && [ "$previous" != "$version" ]; then
    "$claude" plugin update bitfrost@bitfrost >/dev/null 2>&1 || true
  fi

  settings=${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json
  if ! grep -q '"CLAUDE_CODE_ENABLE_FUNCTION_HOOKS" *: *"1"' "$settings" 2>/dev/null; then
    say "one step left. Add this to the \"env\" block of $settings:"
    cmd "\"CLAUDE_CODE_ENABLE_FUNCTION_HOOKS\": \"1\""
  fi
}

find_claude() {
  if command -v claude >/dev/null 2>&1; then
    command -v claude
    return 0
  fi
  for c in "$HOME/.local/bin/claude" "$HOME/.claude/local/claude" \
    "$HOME"/.config/Claude/claude-code/*/claude \
    "$HOME/Library/Application Support/Claude/claude-code"/*/claude; do
    if [ -x "$c" ]; then
      echo "$c"
      return 0
    fi
  done
  return 1
}

# Swap a link in one rename. GNU mv needs -T and BSD mv needs -h to not follow it.
swap() {
  mv -T "$1" "$2" 2>/dev/null && return 0
  mv -h "$1" "$2" 2>/dev/null && return 0
  rm -f "$2" || die "can't replace $2"
  mv "$1" "$2" || die "can't replace $2"
}

# Check the digest itself, not the file name inside the .sha256.
verify() {
  want=$(sed -n '1s/^\([0-9a-fA-F]\{64\}\).*/\1/p' "$1/$2.sha256")
  [ -n "$want" ] || die "$2.sha256 has no SHA-256 in it"
  if command -v sha256sum >/dev/null 2>&1; then
    got=$(sha256sum "$1/$2")
  elif command -v shasum >/dev/null 2>&1; then
    got=$(shasum -a 256 "$1/$2")
  else
    die "need sha256sum or shasum to check the download"
  fi
  got=${got%% *}
  [ "$(echo "$got" | tr 'A-F' 'a-f')" = "$(echo "$want" | tr 'A-F' 'a-f')" ] || die "$2 failed its checksum"
}

check_version() {
  case $1 in
    '' | *[!0-9.]* | .* | *. | *..*) die "not a version: '$1'" ;;
  esac
}

usage() {
  cat <<'EOF2'
Installs or updates bitfrost (the Claude Code plugin and the bitfrostd helper).

  install.sh [--version X.Y.Z] [--from bitfrost-X.Y.Z.tar.gz] [--no-plugin]

  --version X.Y.Z   install this release instead of the latest
  --from FILE       install a tarball you already have (checked against FILE.sha256 if it's there)
  --no-plugin       leave Claude Code alone (only unpack and link the helper)

Run it again to update. Set BITFROST_REPO=owner/repo to install from a fork.
EOF2
}

# Rough check that config.json lists this profile. Only decides whether to warn.
listed() {
  set -- "${1%/}"
  short=$1
  case $1 in "$HOME"/*) short="~${1#"$HOME"}" ;; esac
  grep -qF "\"$(json_escape "$1")\"" "$CONFIG" || grep -qF "\"$(json_escape "$1")/\"" "$CONFIG" ||
    grep -qF "\"$short\"" "$CONFIG" || grep -qF "\"$short/\"" "$CONFIG"
}

json_escape() { printf '%s' "$1" | sed 's/[\\"]/\\&/g'; }
need() { command -v "$1" >/dev/null 2>&1 || die "$1 is needed"; }
say() { printf 'bitfrost: %s\n' "$*"; }
cmd() { printf '    %s\n' "$*"; }
die() {
  printf 'bitfrost: %s\n' "$*" >&2
  exit 1
}

main "$@"
