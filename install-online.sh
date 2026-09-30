#!/usr/bin/env bash
# One-line bootstrap for Linux and macOS.
# Usage: curl -fsSL https://raw.githubusercontent.com/sPROFFEs/m365proxy/main/install-online.sh | bash
set -euo pipefail
umask 077

REPO=${M365PROXY_REPO:-sPROFFEs/m365proxy}
REF=${M365PROXY_REF:-main}
TMP=$(mktemp -d "${TMPDIR:-/tmp}/m365proxy-online.XXXXXXXX")
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

command -v curl >/dev/null 2>&1 || { printf 'ERROR: curl is required.\n' >&2; exit 1; }
command -v tar >/dev/null 2>&1 || { printf 'ERROR: tar is required.\n' >&2; exit 1; }

archive="https://codeload.github.com/${REPO}/tar.gz/refs/heads/${REF}"
printf '[m365proxy] Downloading %s@%s over HTTPS...\n' "$REPO" "$REF"
curl --fail --show-error --silent --location --retry 3 --connect-timeout 20 --max-time 300 \
  --proto '=https' --proto-redir '=https' "$archive" | tar -xzf - -C "$TMP"

SOURCE=''
for candidate in "$TMP"/*; do
  if [[ -d "$candidate" && -f "$candidate/package.json" && -f "$candidate/UPSTREAM.json" ]]; then
    SOURCE=$candidate
    break
  fi
done
[[ -n "$SOURCE" ]] || { printf 'ERROR: downloaded archive does not look like m365proxy.\n' >&2; exit 1; }

case "$(uname -s)" in
  Linux)
    bash "$SOURCE/install.sh" --yes
    ;;
  Darwin)
    bash "$SOURCE/install-macos.sh" --yes
    ;;
  *)
    printf 'ERROR: this bootstrap supports Linux and macOS. On Windows use PowerShell:\n' >&2
    printf '  irm https://raw.githubusercontent.com/%s/%s/install.ps1 | iex\n' "$REPO" "$REF" >&2
    exit 1
    ;;
esac
