#!/bin/sh
# Copyright (C) 2026 Nick Germaine
# SPDX-License-Identifier: GPL-3.0-only
#
# BitFrost is free software: you can share and change it under the GNU General
# Public License, version 3 only. It comes with no warranty. See LICENSE.

# Installs or updates BitFrost from a GitHub release. Run it again to update.
# Options: --version X.Y.Z, --from FILE, --force, --no-plugin.

# build.sh stamps a release's copy with its own version, so that copy installs
# its own release. Left empty here, so this copy installs the latest.
RELEASE=

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
  force=
  hooks_needed=
  restart_needed=
  while [ $# -gt 0 ]; do
    case $1 in
      --version) [ $# -ge 2 ] || die "--version needs a value"; version=${2#v}; shift 2 ;;
      --from) [ $# -ge 2 ] || die "--from needs a file"; from=$2; shift 2 ;;
      --no-plugin) plugin=; shift ;;
      --force) force=1; shift ;;
      -h | --help) usage; exit 0 ;;
      *) die "unknown option: $1" ;;
    esac
  done
  [ -n "$version" ] || [ -n "$from" ] || version=$RELEASE

  need tar
  mkdir -p "$DATA/versions"
  previous=
  if [ -L "$DATA/current" ]; then
    previous=$(readlink "$DATA/current")
    previous=${previous##*/}
  fi
  tmp=$(mktemp -d "$DATA/.install.XXXXXX")
  trap cleanup EXIT
  trap 'cleanup; exit 130' INT TERM

  if [ -n "$from" ]; then
    [ -f "$from" ] || die "no such file: $from"
    base=${from##*/}
    from_version=${base#bitfrost-}
    from_version=${from_version%.tar.gz}
    [ -z "$version" ] || [ "$version" = "$from_version" ] || die "$base is not version $version"
    version=$from_version
    check_version "$version"
    header
    cp "$from" "$tmp/$base"
    if [ -f "$from.sha256" ]; then
      cp "$from.sha256" "$tmp/$base.sha256"
      verify "$tmp" "$base"
      done_ "Checksum" "$base"
    else
      warn "No $base.sha256 next to it, so the checksum was skipped"
    fi
  else
    need curl
    if [ -z "$version" ]; then
      task "Latest release" "asking github.com/$REPO" curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest" ||
        die "can't reach github.com/$REPO"
      url=$(cat "$tmp/log")
      version=${url##*/}
      version=${version#v}
    fi
    check_version "$version"
    header
    base=bitfrost-$version.tar.gz
    if [ -n "$force" ] || [ ! -d "$DATA/versions/$version" ]; then
      dl="https://github.com/$REPO/releases/download/v$version"
      fetch "$dl/$base" "$tmp/$base" || die "can't download $dl/$base"
      curl -fsSL -o "$tmp/$base.sha256" "$dl/$base.sha256" || die "can't download $dl/$base.sha256"
      verify "$tmp" "$base"
      done_ "Downloaded" "$base, checksum ok"
    fi
  fi

  if [ -d "$DATA/versions/$version" ] && [ -z "$force" ]; then
    note "Already unpacked" "$(short "$DATA/versions/$version")"
  else
    mkdir "$tmp/x"
    task "Unpacking" "$base" tar -xzf "$tmp/$base" -C "$tmp/x" || die "can't unpack $base: $(cat "$tmp/log")"
    root=$tmp/x/bitfrost-$version
    manifest=$root/plugins/bitfrost/.claude-plugin/plugin.json
    [ -f "$manifest" ] || die "$base doesn't look like a bitfrost release"
    inside=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$manifest")
    [ "$inside" = "$version" ] || die "$base holds version '$inside', not $version"
    # Renames, so a version folder is never half there. A running helper keeps
    # only the files it already opened, so it is restarted below.
    if [ -d "$DATA/versions/$version" ]; then
      mv "$DATA/versions/$version" "$tmp/old"
      mv "$root" "$DATA/versions/$version"
      done_ "Unpacked again" "$(short "$DATA/versions/$version")"
    else
      mv "$root" "$DATA/versions/$version"
      done_ "Unpacked" "$(short "$DATA/versions/$version")"
    fi
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
  done_ "Command" "$(short "$link")"

  profile=${CLAUDE_CONFIG_DIR:-'~/.claude'}
  if [ ! -e "$CONFIG" ]; then
    mkdir -p "${CONFIG%/*}"
    printf '{\n  "allowedProfiles": ["%s"]\n}\n' "$(json_escape "$profile")" >"$CONFIG"
    done_ "Config" "$(short "$CONFIG")"
  else
    note "Kept your config" "$(short "$CONFIG")"
    if [ -n "${CLAUDE_CONFIG_DIR:-}" ] && ! listed "$CLAUDE_CONFIG_DIR"; then
      warn "Add \"$CLAUDE_CONFIG_DIR\" to allowedProfiles in $(short "$CONFIG"), or that profile gets no subagents"
    fi
  fi

  if [ -n "$plugin" ]; then
    install_plugin
  fi

  # A same-version reinstall is not newer, so Claude would never restart the helper.
  if [ -n "$force" ] && [ "$previous" = "$version" ] && "$link" status >/dev/null 2>&1; then
    if task "Helper" "restarting it" "$link" restart; then
      done_ "Helper" "restarted"
    else
      restart_needed=1
    fi
  fi

  if ! out=$("$link" socket 2>&1); then
    warn "$out"
  fi

  echo
  if [ "$previous" = "$version" ] && [ -n "$force" ]; then
    step "Reinstalled BitFrost $version. New Claude sessions use it."
  elif [ "$previous" = "$version" ]; then
    step "BitFrost $version is installed. New Claude sessions use it."
  elif [ -n "$previous" ]; then
    step "Updated BitFrost $previous -> $version. New Claude sessions use it."
  else
    step "Installed BitFrost $version. New Claude sessions use it."
  fi

  # Only what the user still has to do.
  next=
  case :$PATH: in
    *:"$BIN_DIR":*) ;;
    *) next=1 ;;
  esac
  [ -z "$hooks_needed" ] || next=1
  [ -z "$restart_needed" ] || next=1
  [ -n "$previous" ] || next=1
  [ -n "$next" ] || return 0
  echo
  step "Next steps"
  case :$PATH: in
    *:"$BIN_DIR":*) ;;
    *) todo "Add $(short "$BIN_DIR") to your PATH to use the bitfrost command" ;;
  esac
  if [ -n "$restart_needed" ]; then
    todo "The helper is busy, so it runs the old copy for now. Once no subagent runs:"
    cmd "bitfrost restart"
  fi
  if [ -n "$hooks_needed" ]; then
    todo "Add this to the \"env\" block of $(short "$hooks_needed"):"
    cmd "\"CLAUDE_CODE_ENABLE_FUNCTION_HOOKS\": \"1\""
  fi
  if [ -z "$previous" ]; then
    todo "Codex and ZCode work once installed and signed in. For GLM, also run once:"
    cmd "bitfrost setup zcode"
    todo "opencode, Oh My Pi and Gemini CLI stay off until you turn them on in $(short "$CONFIG")"
    todo "Setup for each app: https://github.com/$REPO/blob/main/GUIDE.md#setup"
  fi
}

install_plugin() {
  claude=$(find_claude) || {
    warn "Claude Code not found. To add the plugin yourself, run:"
    cmd "claude plugin marketplace add $DATA/current"
    cmd "claude plugin install bitfrost@bitfrost --scope user"
    return 0
  }
  # Claude's own messages only show when something fails.
  task "Claude Code plugin" "adding the marketplace" "$claude" plugin marketplace add "$DATA/current" ||
    die "claude plugin marketplace add failed: $(cat "$tmp/log")"
  task "Claude Code plugin" "installing" "$claude" plugin install bitfrost@bitfrost --scope user ||
    die "claude plugin install failed: $(cat "$tmp/log")"
  if [ -n "$previous" ] && [ "$previous" != "$version" ]; then
    task "Claude Code plugin" "updating" "$claude" plugin update bitfrost@bitfrost || true
  fi
  done_ "Claude Code plugin" "bitfrost@bitfrost in $(short "${CLAUDE_CONFIG_DIR:-$HOME/.claude}")"

  settings=${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json
  grep -q '"CLAUDE_CODE_ENABLE_FUNCTION_HOOKS" *: *"1"' "$settings" 2>/dev/null || hooks_needed=$settings
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

  install.sh [--version X.Y.Z] [--from bitfrost-X.Y.Z.tar.gz] [--force] [--no-plugin]

  --version X.Y.Z   install this release instead of the default
  --from FILE       install a tarball you already have (checked against FILE.sha256 if it's there)
  --force           unpack again even if this version is already there, and restart the helper
  --no-plugin       leave Claude Code alone (only unpack and link the helper)

With no --version, a release's copy of this script installs that release, and
any other copy installs the latest. Set BITFROST_REPO=owner/repo to install from a fork.
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

# Spinners only in a terminal; colors also never with NO_COLOR.
TTY=
[ ! -t 1 ] || TTY=1
if [ -n "$TTY" ] && [ -z "${NO_COLOR:-}" ]; then
  B=$(printf '\033[1m') D=$(printf '\033[2m') G=$(printf '\033[32m') Y=$(printf '\033[33m') C=$(printf '\033[1;34m') R=$(printf '\033[1;31m') N=$(printf '\033[0m')
else
  B= D= G= Y= C= R= N=
fi
short() { case $1 in "$HOME" | "$HOME"/*) printf '~%s' "${1#"$HOME"}" ;; *) printf '%s' "$1" ;; esac; }
header() {
  if [ -n "$previous" ] && [ "$previous" != "$version" ]; then step "Updating BitFrost $previous -> $version"
  elif [ "$previous" = "$version" ] && [ -n "$force" ]; then step "Reinstalling BitFrost $version"
  else step "Installing BitFrost $version"; fi
}
step() { printf '%s::%s %s%s%s\n' "$C" "$N" "$B" "$*" "$N"; }
done_() { printf '   %s✓%s %-20s  %s%s%s\n' "$G" "$N" "$1" "$D" "$2" "$N"; }
note() { printf '   %s-%s %-20s  %s%s%s\n' "$D" "$N" "$1" "$D" "$2" "$N"; }
warn() { printf '   %s!%s %s\n' "$Y" "$N" "$*"; }
todo() { printf '   %s-%s %s\n' "$D" "$N" "$*"; }
cmd() { printf '       %s%s%s\n' "$B" "$*" "$N"; }
die() {
  printf '%sbitfrost install:%s %s\n' "$R" "$N" "$*" >&2
  exit 1
}

job=
cleanup() {
  [ -z "$job" ] || kill "$job" 2>/dev/null || true
  rm -rf "$tmp"
  [ -z "$TTY" ] || printf '\033[?25h'
}

# Redraws one line while job $1 runs: label $2, detail $3, and for a download
# into file $4 of $5 bytes, how much has arrived.
spin() {
  [ -n "$TTY" ] || return 0
  i=0
  # Cut to the terminal width: a wrapped line can't be redrawn in place.
  cols=$(stty size 2>/dev/null </dev/tty | awk '{ print $2 }')
  [ "${cols:-0}" -gt 0 ] 2>/dev/null || cols=80
  room=$((cols - 28))
  printf '\033[?25l'
  while kill -0 "$1" 2>/dev/null; do
    case $i in 0) f=⠋ ;; 1) f=⠙ ;; 2) f=⠹ ;; 3) f=⠸ ;; 4) f=⠼ ;; 5) f=⠴ ;; 6) f=⠦ ;; 7) f=⠧ ;; 8) f=⠇ ;; *) f=⠏ ;; esac
    extra=
    if [ -n "${4:-}" ] && [ -f "$4" ]; then
      extra=$(wc -c <"$4" | awk -v t="${5:-0}" '
        function h(b) { return b >= 1048576 ? sprintf("%.1f MiB", b / 1048576) : sprintf("%.0f KiB", b / 1024) }
        { if (t > 0) printf "%d%%  %s / %s", $1 * 100 / t, h($1), h(t); else printf "%s", h($1) }')
    fi
    rest="$3  $extra"
    if [ "$room" -gt 0 ]; then rest=$(printf '%s' "$rest" | cut -c "1-$room"); else rest=; fi
    printf '\r\033[2K   %s%s%s %-20s  %s%s%s' "$C" "$f" "$N" "$2" "$D" "$rest" "$N"
    i=$(((i + 1) % 10))
    sleep 0.1
  done
  printf '\r\033[2K\033[?25h'
}

# Runs a slow step behind a spinner. Its output lands in $tmp/log for the error.
task() {
  label=$1 detail=$2
  shift 2
  "$@" >"$tmp/log" 2>&1 &
  job=$!
  spin "$job" "$label" "$detail"
  wait "$job" && job= || { job=; return 1; }
}

# Downloads URL $1 to file $2, showing how much has arrived.
fetch() {
  total=0
  [ -z "$TTY" ] || total=$(curl -fsSLI "$1" 2>/dev/null | tr -d '\r' | awk 'tolower($1) == "content-length:" { n = $2 } END { print n + 0 }')
  curl -fsSL -o "$2" "$1" >"$tmp/log" 2>&1 &
  job=$!
  spin "$job" "Downloading" "${2##*/}" "$2" "$total"
  wait "$job" && job= || { job=; return 1; }
}

main "$@"
