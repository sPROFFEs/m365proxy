#!/usr/bin/env bash
# Shared Linux installer helpers. Sourcing this file makes no changes.
m365_die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
m365_note() { printf '\n[m365proxy] %s\n' "$*"; }
m365_arch() {
  case "$1" in
    x86_64|amd64) printf 'x64\n' ;;
    aarch64|arm64) printf 'arm64\n' ;;
    *) printf 'Unsupported architecture: %s (requires x86_64 or arm64).\n' "$1" >&2; return 1 ;;
  esac
}
m365_is_debian_like() {
  local text=" ${1:-} ${2:-} "
  [[ "$text" == *debian* ||
     "$text" == *ubuntu* ||
     "$text" == *kali* ||
     "$text" == *parrot* ||
     "$text" == *linuxmint* ||
     "$text" == *pop* ]]
}
m365_candidate() {
  local name
  for name in "$@"; do
    if LC_ALL=C apt-cache policy "$name" 2>/dev/null | awk '/Candidate:/ && $2 != "(none)" { ok=1 } END { exit !ok }'; then
      printf '%s\n' "$name"; return 0
    fi
  done
  printf 'No apt candidate for: %s\n' "$*" >&2
  return 1
}
m365_chromium_packages() {
  # Resolves both classic and t64 package transitions on apt-based systems.
  local group
  for group in \
    'libasound2t64 libasound2' \
    'libatk1.0-0t64 libatk1.0-0' \
    'libatk-bridge2.0-0t64 libatk-bridge2.0-0' \
    'libatspi2.0-0t64 libatspi2.0-0' \
    'libcups2t64 libcups2' \
    'libglib2.0-0t64 libglib2.0-0' \
    'libgtk-3-0t64 libgtk-3-0' \
    libnss3 libnspr4 libdbus-1-3 libdrm2 libexpat1 libgbm1 \
    libpango-1.0-0 libcairo2 libx11-6 libxcb1 libxcomposite1 \
    libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2 \
    libxshmfence1 libxss1 libx11-xcb1 libpangocairo-1.0-0 \
    fonts-liberation fonts-noto-color-emoji xdg-utils; do
    local -a options
    read -r -a options <<< "$group"
    m365_candidate "${options[@]}" || return 1
  done
}
m365_checksum_entry() {
  # Exactly one official Node 24 glibc Linux archive matching this architecture.
  local manifest=$1 arch=$2 requested=${3:-latest}
  awk -v arch="$arch" -v wanted="$requested" '
    $2 ~ ("^node-v24\\.[0-9]+\\.[0-9]+-linux-" arch "\\.tar\\.xz$") {
      name=$2; ver=name; sub(/^node-v/, "", ver); sub(/-linux-.*/, "", ver);
      if (wanted == "latest" || wanted == ver) { hash=$1; file=name; n++ }
    }
    END {
      if (n != 1 || length(hash) != 64 || hash ~ /[^0-9a-fA-F]/) exit 1;
      print tolower(hash), file
    }' "$manifest"
}
