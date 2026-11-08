#!/bin/bash
set -euo pipefail

fail() { printf '%s\n' "$*" >&2; exit 1; }
[ "$(uname -s)" = Darwin ] || fail 'Этот комплект запускается на macOS.'
base_dir="$(cd -- "$(dirname -- "$0")" && pwd -P)"
xattr -dr com.apple.quarantine "$base_dir" 2>/dev/null || true
if [ -d "$base_dir/app" ] && [ -f "$base_dir/app/server.cjs" ]; then
  root="$base_dir/app"
else
  root="$base_dir"
fi
version="$(sw_vers -productVersion)"
major="${version%%.*}"
[ "$major" -ge 11 ] || fail 'Требуется macOS 11 Big Sur или новее.'

case "$(uname -m)" in
  arm64) node_arch=arm64 ;;
  x86_64)
    node_arch=x64
    if [ "$(sysctl -n hw.optional.arm64 2>/dev/null || true)" = 1 ]; then node_arch=arm64; fi
    ;;
  *) fail 'Поддерживаются Intel и Apple Silicon.' ;;
esac

app_home="${CREOMAKER_HOME:-$HOME/Library/Application Support/CreoMaker}"
runtime_dir="$app_home/runtime"
node_dir="$runtime_dir/node-22.23.4-$node_arch"
ffmpeg_arch="$node_arch"
ffmpeg=''
ffprobe=''
if [ "$node_arch" = arm64 ] && [ "$major" -eq 11 ]; then
  ffmpeg="$(command -v ffmpeg || true)"
  ffprobe="$(command -v ffprobe || true)"
  if [ ! -x "$ffmpeg" ] || [ ! -x "$ffprobe" ]; then
    ffmpeg=''
    ffprobe=''
    ffmpeg_arch=x64
    pkgutil --pkg-info com.apple.pkg.RosettaUpdateAuto >/dev/null 2>&1 ||
      fail 'На Apple Silicon с macOS 11 установите Rosetta 2 или добавьте совместимые FFmpeg и FFprobe в PATH. Нативный комплект требует macOS 12.'
  fi
fi
ffmpeg_dir="$runtime_dir/ffmpeg-6.1.1-$ffmpeg_arch"
ffmpeg="${ffmpeg:-$ffmpeg_dir/ffmpeg}"
ffprobe="${ffprobe:-$ffmpeg_dir/ffprobe}"
node="$node_dir/node"

if [ ! -x "$node" ] || [ ! -x "$ffmpeg" ] || [ ! -x "$ffprobe" ]; then
  mkdir -p -- "$runtime_dir" "$node_dir" "$ffmpeg_dir"
  temp="$(mktemp -d "$runtime_dir/.install.XXXXXXXX")"
  trap 'rm -f -- "$temp/node" "$temp/ffmpeg" "$temp/ffprobe"; rmdir -- "$temp"' EXIT
  install_binary() {
    local archive="$1" target="$2" unpacked="${3:-}" name expected actual
    name="${target##*/}"
    expected="$(awk -v file="$archive" '$2 == file {print $1}' "$root/runtime/SHA256SUMS")"
    actual="$(shasum -a 256 "$root/runtime/$archive")"
    [ -n "$expected" ] && [ "${actual%% *}" = "$expected" ] ||
      fail "Контрольная сумма не совпала: $archive. Распакуйте комплект заново."
    if [ -n "$unpacked" ]; then
      tar -xOzf "$root/runtime/$archive" "$unpacked" > "$temp/$name"
    else
      gzip -dc "$root/runtime/$archive" > "$temp/$name"
    fi
    chmod 755 "$temp/$name"
    mv -f -- "$temp/$name" "$target"
  }
  printf '%s\n' 'Устанавливаем локальные инструменты CreoMaker…'
  if [ ! -x "$node" ]; then
    node_prefix="node-v22.23.4-darwin-$node_arch"
    install_binary "$node_prefix.tar.gz" "$node" "$node_prefix/bin/node"
  fi
  if [ ! -x "$ffmpeg" ]; then install_binary "ffmpeg-darwin-$ffmpeg_arch.gz" "$ffmpeg"; fi
  if [ ! -x "$ffprobe" ]; then install_binary "ffprobe-darwin-$ffmpeg_arch.gz" "$ffprobe"; fi
  trap - EXIT
  rmdir -- "$temp"
fi

"$node" --version >/dev/null || fail 'Не удалось запустить Node.js.'
"$ffprobe" -version >/dev/null || fail 'Не удалось запустить FFprobe.'
"$ffmpeg" -hide_banner -loglevel error -f lavfi -i color=size=64x64 -frames:v 1 -c:v libx264 -f null - ||
  fail 'FFmpeg не смог выполнить пробное кодирование H.264.'
printf '%s\n' "Инструменты готовы · macOS $version · Node $node_arch · FFmpeg $ffmpeg_arch"
[ "${1:-}" != --check ] || exit 0

export CREO_FFMPEG_PATH="$ffmpeg" CREO_FFPROBE_PATH="$ffprobe"
export CREO_DATA_DIR="${CREO_DATA_DIR:-$app_home/data}"
export CREO_ASSET_DIR="${CREO_ASSET_DIR:-$root/assets}"
cd -- "$root"
exec "$node" "$root/server.cjs" --open
