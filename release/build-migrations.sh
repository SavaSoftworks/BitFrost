#!/bin/sh
# Copyright (C) 2026 Nick Germaine; SPDX-License-Identifier: GPL-3.0-only
# --static produces a self-contained Linux binary, or a macOS universal binary
# with only operating-system dylibs. No COBOL/SQLite installation is needed by users.
set -eu
cd "$(dirname "$0")/.."
static=
out=
versions=
build_dir=
manifest=$PWD/package.json
while [ $# -gt 0 ]; do
  case $1 in
    --static) static=1 ;;
    --versions) shift; versions=${1:?--versions requires a directory} ;;
    --build-dir) shift; build_dir=${1:?--build-dir requires a directory} ;;
    --package-json) shift; manifest=${1:?--package-json requires a file} ;;
    -*) echo "build-migrations.sh: unknown option $1" >&2; exit 1 ;;
    *) [ -z "$out" ] || { echo "Only one output path is allowed" >&2; exit 1; }; out=$1 ;;
  esac
  shift
done

# Keep dependency builds, code generation and the linker inside the same CPU budget.
. ./release/build-cpu.sh
src=$PWD/plugins/bitfrost/migrations
build=${build_dir:-$src/build}
versions=${versions:-$src/versions}
mkdir -p "$build"
build=$(cd "$build" && pwd)
versions=$(cd "$versions" && pwd)
mkdir -p "$build/generated"
node release/generate-migrations.mjs "$src/src" "$versions" "$build/generated" "$manifest"
if [ -z "$static" ]; then
  # Preserve configured dependency paths (including Homebrew's keg-only GMP).
  # Append our flags instead of replacing the compiler and linker defaults.
  cobc -x -free -ftext-column=255 -Wall -Wno-possible-truncate -O2 \
    -A '-std=gnu11 -fno-lto' -Q '-fno-lto' \
    -I"$src/src" -I"$build/generated" \
    -o "$build/bitfrost-migrate" "$build/generated/combined.cob" \
    "$src/src/sqlite.c" -lsqlite3
else
  command -v m4 >/dev/null 2>&1 || { echo 'build-migrations.sh: m4 is required to build GMP' >&2; exit 1; }
  mkdir -p "$build/vendor" "$build/generated"
  download() {
    name=$1 url=$2 hash=$3
    if [ ! -f "$build/vendor/$name" ]; then curl -fL --retry 3 "$url" -o "$build/vendor/$name"; fi
    actual=$(if command -v sha256sum >/dev/null 2>&1; then sha256sum "$build/vendor/$name"; else shasum -a 256 "$build/vendor/$name"; fi)
    [ "${actual%% *}" = "$hash" ] || { echo "Checksum mismatch: $name" >&2; exit 1; }
  }
  download gnucobol-3.2.tar.xz https://ftp.gnu.org/gnu/gnucobol/gnucobol-3.2.tar.xz \
    3bb48af46ced4779facf41fdc2ee60e4ccb86eaa99d010b36685315df39c2ee2
  download gmp-6.3.0.tar.xz https://ftp.gnu.org/gnu/gmp/gmp-6.3.0.tar.xz \
    a3c2b80201b89e68616f4ad30bc66aee4927c3ce50e33929ca819d5c43538898
  download sqlite-amalgamation-3500400.zip https://www.sqlite.org/2025/sqlite-amalgamation-3500400.zip \
    1d3049dd0f830a025a53105fc79fd2ab9431aea99e137809d064d8ee8356b032
  [ -d "$build/vendor/gnucobol-3.2" ] || tar -xJf "$build/vendor/gnucobol-3.2.tar.xz" -C "$build/vendor"
  [ -d "$build/vendor/gmp-6.3.0" ] || tar -xJf "$build/vendor/gmp-6.3.0.tar.xz" -C "$build/vendor"
  [ -d "$build/vendor/sqlite-amalgamation-3500400" ] || unzip -q "$build/vendor/sqlite-amalgamation-3500400.zip" -d "$build/vendor"
  # Every versions/vN/main.cob was registered above, in numeric order.
  # Nest handlers so portable C resolves calls without runtime loading.
  (cd "$build/generated" && cobc -C -x -free -ftext-column=255 -Wall -Wno-possible-truncate -I"$src/src" -I. combined.cob)
  arches=native
  [ "$(uname -s)" != Darwin ] || arches='arm64 x86_64'
  for arch in $arches; do
    prefix=$build/$arch/prefix
    mkdir -p "$prefix" "$build/$arch/gmp" "$build/$arch/cobol"
    arch_flags=
    host=
    link_flags=
    extra_libs=
    if [ "$arch" != native ]; then
      arch_flags="-arch $arch -mmacosx-version-min=12.3"
      host="--host=$arch-apple-darwin --build=$(uname -m)-apple-darwin"
      extra_libs=-liconv
    else
      link_flags=-static
      extra_libs=-ldl
    fi
    if [ ! -f "$prefix/lib/libgmp.a" ]; then
      # shellcheck disable=SC2086
      (cd "$build/$arch/gmp" &&
        "$build/vendor/gmp-6.3.0/configure" --prefix="$prefix" --disable-shared --enable-static --disable-cxx --disable-assembly $host \
          CC="${CC:-cc}" CFLAGS="-std=gnu11 -O2 $arch_flags" &&
        make -j "$jobs" && make install)
    fi
    if [ ! -f "$build/$arch/cobol/runtime-built" ]; then
      # shellcheck disable=SC2086
      (cd "$build/$arch/cobol" &&
        "$build/vendor/gnucobol-3.2/configure" --prefix="$prefix" --disable-shared --enable-static --disable-nls \
          --without-db --without-curses --without-xml2 --with-json=no --with-dl $host \
          CC="${CC:-cc}" CFLAGS="-std=gnu11 -O2 $arch_flags" CPPFLAGS="-I$prefix/include" LDFLAGS="-L$prefix/lib $arch_flags" \
          GMP_CFLAGS="-I$prefix/include" GMP_LIBS="-L$prefix/lib -lgmp" &&
        make -C libcob -j "$jobs" && touch runtime-built)
    fi
    # No LTO, so the single linker process cannot start extra compiler workers.
    # shellcheck disable=SC2086
    "${CC:-cc}" -std=gnu11 -O2 -fno-lto $arch_flags $link_flags -I"$build/vendor/gnucobol-3.2" \
      -I"$prefix/include" \
      -I"$build/$arch/cobol" -I"$build/vendor/sqlite-amalgamation-3500400" \
      -DSQLITE_THREADSAFE=0 -DSQLITE_OMIT_LOAD_EXTENSION \
      "$build/generated/combined.c" "$src/src/sqlite.c" \
      "$build/vendor/sqlite-amalgamation-3500400/sqlite3.c" \
      "$build/$arch/cobol/libcob/.libs/libcob.a" "$prefix/lib/libgmp.a" -lm $extra_libs \
      -o "$build/bitfrost-migrate-$arch"
  done
  if [ "$arches" = native ]; then
    cp "$build/bitfrost-migrate-native" "$build/bitfrost-migrate"
  else
    lipo -create "$build/bitfrost-migrate-arm64" "$build/bitfrost-migrate-x86_64" -output "$build/bitfrost-migrate"
  fi
fi
"$build/bitfrost-migrate" --version
if [ -n "$out" ]; then
  mkdir -p "$(dirname "$out")"
  cp "$build/bitfrost-migrate" "$out"
  chmod 755 "$out"
fi
