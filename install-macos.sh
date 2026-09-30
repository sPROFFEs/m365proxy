#!/usr/bin/env bash
# m365proxy installer for macOS (Intel and Apple Silicon).
# Run as the normal desktop user. No sudo is used by this installer.
set -Eeuo pipefail
umask 077

SOURCE=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
PREFIX=${M365PROXY_PREFIX:-$HOME/.local/share/m365proxy}
BIN_DIR=${M365PROXY_BIN_DIR:-$HOME/.local/bin}
NODE_VERSION=latest
SYSTEM_NODE=0
EDIT_PATH=1
ASSUME_YES=0
CHECK_BROWSER=1
DRY_RUN=0
TEMP=''
RELEASE=''
STATE_GUARD_PID=''
STATE_GUARD_FD_OPEN=0

m365_die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
m365_note() { printf '\n[m365proxy] %s\n' "$*"; }
m365_warn() { printf 'WARNING: %s\n' "$*" >&2; }

usage() {
  cat <<'HELP'
Usage: bash install-macos.sh [options]

Installs m365proxy for the current macOS user.

  --yes, -y             Accept installation without the confirmation prompt.
  --use-system-node     Reuse installed Node >=24 plus npm.
  --node-version X.Y.Z  Pin a stable Node 24 release; default resolves latest 24.x.
  --prefix PATH         User-owned installation directory.
  --bin-dir PATH        Launcher directory; default ~/.local/bin.
  --no-path             Do not edit Bash/Zsh startup files.
  --skip-browser-check  Skip the local about:blank Chromium smoke test.
  --dry-run             Print the plan without changes or downloads.
  -h, --help            Show this help.

Git is required to fetch the pinned upstream source when it is not bundled.
The installer provisions a private Node 24 runtime by default and never signs in
or starts a background service.
HELP
}

need_value() {
  [[ $# -ge 2 && -n "$2" && "$2" != --* ]] || m365_die "Missing value for $1"
}

while (($#)); do
  case "$1" in
    --yes|-y) ASSUME_YES=1 ;;
    --use-system-node) SYSTEM_NODE=1 ;;
    --no-path) EDIT_PATH=0 ;;
    --skip-browser-check) CHECK_BROWSER=0 ;;
    --dry-run) DRY_RUN=1 ;;
    --node-version) need_value "$@"; NODE_VERSION=${2#v}; shift ;;
    --prefix) need_value "$@"; PREFIX=$2; shift ;;
    --bin-dir) need_value "$@"; BIN_DIR=$2; shift ;;
    -h|--help) usage; exit 0 ;;
    *) m365_die "Unknown option: $1. Use --help." ;;
  esac
  shift
done

[[ $(uname -s) == Darwin ]] || m365_die 'This installer requires macOS. Use install.sh on Linux or install.ps1 on Windows.'
case "$(uname -m)" in
  x86_64|amd64) ARCH=x64 ;;
  arm64|aarch64) ARCH=arm64 ;;
  *) m365_die "Unsupported architecture: $(uname -m). Requires x86_64 or arm64." ;;
esac

[[ "$NODE_VERSION" == latest || "$NODE_VERSION" =~ ^24\.[0-9]+\.[0-9]+$ ]] \
  || m365_die '--node-version must be a stable 24.x.y release.'
((SYSTEM_NODE == 0)) || [[ "$NODE_VERSION" == latest ]] \
  || m365_die '--use-system-node cannot be combined with --node-version.'

for item in "$PREFIX" "$BIN_DIR"; do
  [[ "$item" == /* && "$item" != *$'\n'* && "$item" != *$'\r'* ]] \
    || m365_die 'Installation paths must be absolute and may not contain line breaks.'
done
[[ "$PREFIX" != / && "$PREFIX" != "$HOME" && "$PREFIX" != "$SOURCE" ]] \
  || m365_die 'Use a dedicated user-owned prefix, not /, your home directory, or the source directory.'
[[ "$SOURCE/" != "$PREFIX/"* ]] \
  || m365_die 'Keep the source checkout outside the installation prefix.'

cat <<PLAN
Installation plan
  Platform:      macOS ($(uname -m))
  Application:   $PREFIX/releases/...
  Command:       $BIN_DIR/m365proxy
  Node:          $([[ $SYSTEM_NODE == 1 ]] && printf 'existing Node >=24 + npm' || printf 'private Node 24 (%s)' "$NODE_VERSION")
  Shell PATH:    $([[ $EDIT_PATH == 1 ]] && printf 'Bash/Zsh managed block' || printf 'unchanged')
  Browser:       Playwright Chromium, private download cache
  Account data:  ~/.m365-copilot-local (existing profile/key preserved)
No Microsoft sign-in or service auto-start occurs during installation.
PLAN

((DRY_RUN)) && exit 0
[[ $(id -u) -ne 0 ]] || m365_die 'Run this installer as your normal desktop user, not as root.'

if ((!ASSUME_YES)); then
  [[ -t 0 ]] || m365_die 'Non-interactive input: pass --yes or run in a terminal.'
  read -r -p 'Continue? [y/N] ' answer
  [[ "$answer" =~ ^[yY]([eE][sS])?$ ]] || { printf 'Cancelled.\n'; exit 0; }
fi

for tool in curl tar awk shasum mkfifo grep; do
  command -v "$tool" >/dev/null || m365_die "Missing required macOS tool: $tool"
done
if ! git --version >/dev/null 2>&1; then
  if command -v brew >/dev/null 2>&1; then
    m365_note 'Git is missing; installing it with Homebrew.'
    brew install git
  else
    m365_die 'Git is required. Install Xcode Command Line Tools (xcode-select --install) or Homebrew Git, then rerun.'
  fi
fi

STATE=${M365_LOCAL_STATE_DIR:-$HOME/.m365-copilot-local}
if [[ -e "$PREFIX" ]]; then
  [[ -d "$PREFIX" && -O "$PREFIX" ]] || m365_die 'The prefix must be a directory owned by your user.'
  if [[ -n $(ls -A "$PREFIX" 2>/dev/null) ]]; then
    [[ -f "$PREFIX/.m365proxy-install" && $(cat "$PREFIX/.m365proxy-install") == m365proxy-user-install-v1 ]] \
      || m365_die 'Non-empty prefix does not belong to this installer; refusing to overwrite it.'
  fi
fi
mkdir -p "$PREFIX" "$PREFIX/runtime" "$PREFIX/releases" "$PREFIX/bin" "$PREFIX/browsers" "$BIN_DIR"
chmod 700 "$PREFIX"
printf 'm365proxy-user-install-v1\n' > "$PREFIX/.m365proxy-install"

if [[ -e "$BIN_DIR/m365proxy" || -L "$BIN_DIR/m365proxy" ]]; then
  [[ -L "$BIN_DIR/m365proxy" && $(readlink "$BIN_DIR/m365proxy") == "$PREFIX/bin/m365proxy" ]] \
    || m365_die 'An unrelated m365proxy command already exists in the bin directory.'
fi

TEMP=$(mktemp -d "$PREFIX/.download.XXXXXXXX")
cleanup() {
  code=$?
  if ((STATE_GUARD_FD_OPEN)); then exec 7>&- || true; STATE_GUARD_FD_OPEN=0; fi
  if [[ -n "$STATE_GUARD_PID" ]]; then wait "$STATE_GUARD_PID" 2>/dev/null || true; fi
  [[ -z "$TEMP" || ! -d "$TEMP" ]] || rm -rf "$TEMP"
  if ((code != 0)); then
    printf '\nInstallation failed; existing Microsoft account data was left untouched.\n' >&2
    [[ -z "$RELEASE" ]] || printf 'Unactivated release retained for diagnosis: %s\n' "$RELEASE" >&2
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

if ((SYSTEM_NODE)); then
  command -v node >/dev/null && command -v npm >/dev/null \
    || m365_die '--use-system-node requires both node and npm on PATH.'
  NODE=$(node -p 'process.execPath')
  "$NODE" -e 'if (Number(process.versions.node.split(".")[0]) < 24) process.exit(1)' \
    || m365_die 'Existing Node is older than 24.'
else
  m365_note 'Downloading the official Node 24 checksum manifest over HTTPS.'
  if [[ "$NODE_VERSION" == latest ]]; then
    dist='https://nodejs.org/download/release/latest-v24.x'
  else
    dist="https://nodejs.org/download/release/v$NODE_VERSION"
  fi
  curl --fail --show-error --silent --location --retry 3 --connect-timeout 20 --max-time 300 \
    --proto '=https' --proto-redir '=https' "$dist/SHASUMS256.txt" -o "$TEMP/SHASUMS256.txt"
  entry=$(awk -v arch="$ARCH" -v wanted="$NODE_VERSION" '
    $2 ~ ("^node-v24\\.[0-9]+\\.[0-9]+-darwin-" arch "\\.tar\\.gz$") {
      name=$2; ver=name; sub(/^node-v/, "", ver); sub(/-darwin-.*/, "", ver);
      if (wanted == "latest" || wanted == ver) { hash=$1; file=name; n++ }
    }
    END { if (n != 1 || length(hash) != 64 || hash ~ /[^0-9a-fA-F]/) exit 1; print tolower(hash), file }
  ' "$TEMP/SHASUMS256.txt") || m365_die 'Node checksum manifest did not contain exactly one matching macOS Node 24 archive.'
  read -r expected archive <<< "$entry"
  node_version=${archive#node-v}; node_version=${node_version%-darwin-*}
  RUNTIME="$PREFIX/runtime/node-v$node_version-darwin-$ARCH"
  if [[ ! -x "$RUNTIME/bin/node" || ! -f "$RUNTIME/.archive-sha256" || $(cat "$RUNTIME/.archive-sha256" 2>/dev/null) != "$expected" ]]; then
    [[ ! -e "$RUNTIME" ]] || m365_die "Existing private runtime is incomplete or has a different checksum: $RUNTIME"
    m365_note "Installing private Node v$node_version. System Node remains unchanged."
    curl --fail --show-error --silent --location --retry 3 --connect-timeout 20 --max-time 1800 \
      --proto '=https' --proto-redir '=https' "https://nodejs.org/download/release/v$node_version/$archive" -o "$TEMP/$archive"
    actual=$(shasum -a 256 "$TEMP/$archive" | awk '{print $1}')
    [[ "$actual" == "$expected" ]] || m365_die 'Node archive checksum verification failed.'
    mkdir "$TEMP/runtime"
    tar -xzf "$TEMP/$archive" -C "$TEMP/runtime" --strip-components 1
    printf '%s\n' "$expected" > "$TEMP/runtime/.archive-sha256"
    "$TEMP/runtime/bin/node" -e 'if (Number(process.versions.node.split(".")[0]) !== 24) process.exit(1)' \
      || m365_die 'Downloaded Node 24 cannot run on this Mac.'
    mv "$TEMP/runtime" "$RUNTIME"
  fi
  NODE="$RUNTIME/bin/node"
fi

export PATH="$(dirname "$NODE"):$PATH"
export PLAYWRIGHT_BROWSERS_PATH="$PREFIX/browsers"
export PLAYWRIGHT_SKIP_BROWSER_GC=1

# Hold the same application state lock while preparing and activating the release.
GUARD_FIFO="$TEMP/state-guard.in"
GUARD_OUT="$TEMP/state-guard.out"
GUARD_ERR="$TEMP/state-guard.err"
mkfifo "$GUARD_FIFO"
"$NODE" "$SOURCE/scripts/state-lock.mjs" "$STATE" < "$GUARD_FIFO" > "$GUARD_OUT" 2> "$GUARD_ERR" &
STATE_GUARD_PID=$!
exec 7>"$GUARD_FIFO"
STATE_GUARD_FD_OPEN=1
ready=0
for _n in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  if grep -q '^READY$' "$GUARD_OUT" 2>/dev/null; then ready=1; break; fi
  kill -0 "$STATE_GUARD_PID" 2>/dev/null || break
  sleep 1
done
if ((ready == 0)); then
  cat "$GUARD_ERR" >&2 2>/dev/null || true
  m365_die 'Cannot acquire the state directory. Close an active proxy/browser and retry.'
fi

RELEASE=$(mktemp -d "$PREFIX/releases/release-$(date -u +%Y%m%dT%H%M%SZ)-XXXXXXXX")
items=(src scripts tests examples docs package.json UPSTREAM.json README.md LICENSE THIRD_PARTY_NOTICES.md TEST_REPORT.md .gitignore install.sh install-macos.sh install-online.sh install.ps1)
for item in "${items[@]}"; do
  [[ ! -e "$SOURCE/$item" ]] || cp -R "$SOURCE/$item" "$RELEASE/"
done
if [[ $("$NODE" -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).bundledInThisZip === true' "$SOURCE/UPSTREAM.json") == true ]]; then
  mkdir -p "$RELEASE/vendor"
  cp -R "$SOURCE/vendor/cramt" "$RELEASE/vendor/"
  cp "$SOURCE/UPSTREAM_FILES_SHA256.json" "$RELEASE/"
fi
printf '%s\n' "$NODE" > "$RELEASE/.node-path"

m365_note 'Fetching/verifying pinned upstream source, installing dependencies and building.'
"$NODE" "$RELEASE/scripts/bootstrap.mjs" --skip-browser
m365_note 'Installing the Chromium revision required by the pinned Playwright dependency.'
"$NODE" "$RELEASE/scripts/browser-setup.mjs" install
if ((CHECK_BROWSER)); then
  m365_note 'Smoke-testing Chromium locally with about:blank. No Microsoft login is performed.'
  "$NODE" "$RELEASE/scripts/browser-setup.mjs" check
else
  m365_warn 'Browser smoke test skipped. Browser startup has NOT been verified.'
fi
"$NODE" "$RELEASE/src/cli.mjs" doctor

if ((EDIT_PATH)); then
  "$NODE" "$RELEASE/scripts/linux-path.mjs" add "$BIN_DIR"
fi
install -m 700 "$RELEASE/scripts/macos/launcher.sh" "$PREFIX/bin/m365proxy"

# Atomic current-release switch: create a new symlink and rename it over the old one.
CURRENT_NEW="$PREFIX/.current-new-$$"
rm -f "$CURRENT_NEW"
ln -s "$RELEASE" "$CURRENT_NEW"
"$NODE" --input-type=module -e 'import{renameSync}from"node:fs";renameSync(process.argv[1],process.argv[2])' "$CURRENT_NEW" "$PREFIX/current"

if [[ ! -L "$BIN_DIR/m365proxy" ]]; then
  ln -s "$PREFIX/bin/m365proxy" "$BIN_DIR/m365proxy"
fi
if [[ ! -e "$BIN_DIR/m365prox" && ! -L "$BIN_DIR/m365prox" ]]; then
  ln -s "$PREFIX/bin/m365proxy" "$BIN_DIR/m365prox"
fi

# Release the installation guard before invoking the installed command.
exec 7>&-
STATE_GUARD_FD_OPEN=0
wait "$STATE_GUARD_PID" 2>/dev/null || true
STATE_GUARD_PID=''

"$BIN_DIR/m365proxy" --help
printf '\nInstallation completed for user %s.\n' "$(id -un)"
printf 'Open a new terminal, or run:\n\n  export PATH=%q:"$PATH"\n\n' "$BIN_DIR"
printf 'Then run: m365proxy menu\n'
printf 'No Microsoft session has been tested by this installer.\n'
