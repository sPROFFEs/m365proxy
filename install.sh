#!/usr/bin/env bash
# m365proxy installer for Linux.
#
# Distribution policy:
#   - Hard requirements: Linux + x86_64/amd64 or arm64/aarch64.
#   - No Debian/Kali/Parrot/Ubuntu whitelist.
#   - When automatic system dependencies are enabled, any distro exposing
#     apt-get + apt-cache is allowed. Package availability is detected at runtime.
#   - Unknown/derivative distributions produce a warning, not a hard failure.
#
# Run this script as the normal desktop user, not with sudo.
# sudo is used only for apt when system dependencies must be installed.

set -Eeuo pipefail
umask 077

SOURCE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)

# -----------------------------------------------------------------------------
# Helpers
# -----------------------------------------------------------------------------

m365_die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

m365_note() {
  printf '\n[m365proxy] %s\n' "$*"
}

m365_warn() {
  printf 'WARNING: %s\n' "$*" >&2
}

m365_arch() {
  case "$1" in
    x86_64|amd64)
      printf 'x64\n'
      ;;
    aarch64|arm64)
      printf 'arm64\n'
      ;;
    *)
      printf 'Unsupported architecture: %s (requires x86_64/amd64 or arm64/aarch64).\n' "$1" >&2
      return 1
      ;;
  esac
}

m365_is_debian_like() {
  local text=" ${ID:-} ${ID_LIKE:-} "
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
    if LC_ALL=C apt-cache policy "$name" 2>/dev/null \
      | awk '/Candidate:/ && $2 != "(none)" { ok=1 } END { exit !ok }'; then
      printf '%s\n' "$name"
      return 0
    fi
  done

  printf 'No apt candidate for any of: %s\n' "$*" >&2
  return 1
}

m365_chromium_packages() {
  # Resolve package-name transitions dynamically instead of tying the installer
  # to a distro/version whitelist. This covers traditional Debian package names
  # and the t64 transition used by newer Debian/testing-derived distributions.
  local group
  local -a options

  for group in \
    'libasound2t64 libasound2' \
    'libatk1.0-0t64 libatk1.0-0' \
    'libatk-bridge2.0-0t64 libatk-bridge2.0-0' \
    'libatspi2.0-0t64 libatspi2.0-0' \
    'libcups2t64 libcups2' \
    'libglib2.0-0t64 libglib2.0-0' \
    'libgtk-3-0t64 libgtk-3-0' \
    'libnss3' \
    'libnspr4' \
    'libdbus-1-3' \
    'libdrm2' \
    'libexpat1' \
    'libgbm1' \
    'libpango-1.0-0' \
    'libcairo2' \
    'libx11-6' \
    'libxcb1' \
    'libxcomposite1' \
    'libxdamage1' \
    'libxext6' \
    'libxfixes3' \
    'libxkbcommon0' \
    'libxrandr2' \
    'libxshmfence1' \
    'libxss1' \
    'libx11-xcb1' \
    'libpangocairo-1.0-0' \
    'fonts-liberation' \
    'fonts-noto-color-emoji' \
    'xdg-utils'; do
      read -r -a options <<< "$group"
      m365_candidate "${options[@]}" || return 1
  done
}

m365_checksum_entry() {
  # Exactly one official Node 24 glibc Linux archive matching this architecture.
  local manifest=$1
  local arch=$2
  local requested=${3:-latest}

  awk -v arch="$arch" -v wanted="$requested" '
    $2 ~ ("^node-v24\\.[0-9]+\\.[0-9]+-linux-" arch "\\.tar\\.xz$") {
      name=$2
      ver=name
      sub(/^node-v/, "", ver)
      sub(/-linux-.*/, "", ver)
      if (wanted == "latest" || wanted == ver) {
        hash=$1
        file=name
        n++
      }
    }
    END {
      if (n != 1 || length(hash) != 64 || hash ~ /[^0-9a-fA-F]/) exit 1
      print tolower(hash), file
    }' "$manifest"
}

# -----------------------------------------------------------------------------
# Defaults / arguments
# -----------------------------------------------------------------------------

PREFIX=${XDG_DATA_HOME:-$HOME/.local/share}/m365proxy
BIN_DIR=$HOME/.local/bin
NODE_VERSION=latest
SYSTEM_DEPS=1
SYSTEM_NODE=0
EDIT_PATH=1
ASSUME_YES=0
DRY_RUN=0
CHECK_BROWSER=1

usage() {
  cat <<'HELP'
Usage: bash install.sh [options]

Installs the local M365 proxy and the m365proxy command for the current user.

Linux policy:
  * No distro-name/version whitelist.
  * Debian, Kali, Parrot, Ubuntu, Mint and other derivatives are accepted.
  * Any other Linux distro is also accepted when its required dependencies are
    already installed (--no-system-deps).
  * Automatic dependency installation works on apt-based systems exposing
    apt-get and apt-cache. Package names are detected at runtime.

Requires Internet and an ordinary desktop user account. Run WITHOUT sudo.

  --yes                 Accept installation; sudo may still ask for a password.
  --no-system-deps      Do not invoke sudo/apt; OS libraries must already exist.
  --use-system-node     Reuse installed Node >=24 plus npm instead of private Node.
  --node-version X.Y.Z  Pin a stable Node 24 release; default resolves latest 24.x.
  --prefix PATH         User-owned installation directory.
  --bin-dir PATH        Launcher directory; default ~/.local/bin.
  --no-path             Do not edit Bash/Zsh startup files.
  --skip-browser-check  Skip the local about:blank Chromium smoke test.
  --dry-run             Print the plan without changes, downloads or sudo.
  -h, --help            Show this help.

Defaults:
  private Node 24 + npm, pinned cramt source/dependencies, Playwright Chromium,
  required shared libraries and PATH integration for Bash/Zsh.

Microsoft login/MFA is performed manually later by running:

  m365proxy
HELP
}

need_value() {
  [[ $# -ge 2 && -n "$2" && "$2" != --* ]] || m365_die "Missing value for $1"
}

while (($#)); do
  case "$1" in
    --yes|-y)
      ASSUME_YES=1
      ;;
    --no-system-deps)
      SYSTEM_DEPS=0
      ;;
    --use-system-node)
      SYSTEM_NODE=1
      ;;
    --no-path)
      EDIT_PATH=0
      ;;
    --skip-browser-check)
      CHECK_BROWSER=0
      ;;
    --dry-run)
      DRY_RUN=1
      ;;
    --node-version)
      need_value "$@"
      NODE_VERSION=${2#v}
      shift
      ;;
    --prefix)
      need_value "$@"
      PREFIX=$2
      shift
      ;;
    --bin-dir)
      need_value "$@"
      BIN_DIR=$2
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      m365_die "Unknown option: $1. Use --help."
      ;;
  esac
  shift
done

# -----------------------------------------------------------------------------
# Platform detection: capability-based, not distro-whitelist-based
# -----------------------------------------------------------------------------

[[ $(uname -s) == Linux ]] || m365_die 'This installer currently requires Linux.'
ARCH=$(m365_arch "$(uname -m)") || exit 1

# /etc/os-release is informational only. Missing metadata does NOT block install.
ID=''
ID_LIKE=''
VERSION_ID=''
PRETTY_NAME='Unknown Linux'
if [[ -r /etc/os-release ]]; then
  # shellcheck disable=SC1091
  source /etc/os-release
fi

DISTRO_LABEL=${PRETTY_NAME:-${ID:-Unknown Linux}}

if ((SYSTEM_DEPS)); then
  command -v apt-get >/dev/null || m365_die \
    "Automatic system-dependency installation requires apt-get. This distro is not blocked: install the browser/system libraries yourself and rerun with --no-system-deps."

  command -v apt-cache >/dev/null || m365_die \
    "Automatic system-dependency installation requires apt-cache. Install apt utilities or rerun with --no-system-deps."

  if m365_is_debian_like; then
    m365_note "Detected Debian-like/apt-based system: $DISTRO_LABEL"
  else
    m365_warn "Unrecognized distro family: $DISTRO_LABEL"
    m365_warn 'No distro whitelist is enforced. apt package candidates will be resolved dynamically and Chromium will be smoke-tested.'
  fi
else
  if ! m365_is_debian_like; then
    m365_warn "Unrecognized distro family: $DISTRO_LABEL"
    m365_warn 'Continuing because --no-system-deps was selected; required native libraries must already be installed.'
  fi
fi

[[ "$NODE_VERSION" == latest || "$NODE_VERSION" =~ ^24\.[0-9]+\.[0-9]+$ ]] \
  || m365_die '--node-version must be a stable 24.x.y release.'

if ((SYSTEM_NODE)) && [[ "$NODE_VERSION" != latest ]]; then
  m365_die '--use-system-node cannot be combined with --node-version.'
fi

for item in "$PREFIX" "$BIN_DIR"; do
  [[ "$item" == /* && "$item" != *$'\n'* && "$item" != *$'\r'* ]] \
    || m365_die 'Installation paths must be absolute and may not contain line breaks.'
done

command -v realpath >/dev/null || m365_die 'realpath is required (normally provided by coreutils).'

PREFIX=$(realpath -m -- "$PREFIX")
BIN_DIR=$(realpath -m -- "$BIN_DIR")

[[ "$BIN_DIR" != *:* ]] || m365_die 'The bin directory cannot contain a colon (PATH separator).'

[[ "$PREFIX" != / &&
   "$PREFIX" != "$HOME" &&
   "$PREFIX" != "$SOURCE" &&
   "$PREFIX" != /usr* &&
   "$PREFIX" != /etc* &&
   "$PREFIX" != /bin* ]] \
  || m365_die 'Use a dedicated user-owned prefix, not a system directory or your source/home directory.'

[[ "$SOURCE/" != "$PREFIX/"* ]] \
  || m365_die 'Extract the ZIP outside the installation prefix before reinstalling.'

cat <<PLAN

Installation plan
  Distribution: $DISTRO_LABEL
  Architecture: $ARCH
  Application:  $PREFIX/releases/...
  Command:      $BIN_DIR/m365proxy
  Node:         $([[ $SYSTEM_NODE == 1 ]] && printf 'existing Node >=24 + npm' || printf 'private Node 24 (%s)' "$NODE_VERSION")
  System deps:  $([[ $SYSTEM_DEPS == 1 ]] && printf 'apt via sudo; packages resolved dynamically' || printf 'skipped; existing dependencies required')
  Shell PATH:   $([[ $EDIT_PATH == 1 ]] && printf 'Bash and Zsh; managed blocks with backup' || printf 'unchanged')
  Browser:      Playwright Chromium, private download cache
  Account data: ~/.m365-copilot-local (existing profile/key preserved)

No Microsoft sign-in or service auto-start occurs during installation.
The distro name/version itself is NOT used as an installation blocker.
A previous application release is replaced only after build/checks succeed.
PLAN

((DRY_RUN)) && exit 0

# A browser profile/session should belong to the normal desktop user. Running the
# entire application as root creates ownership/sandbox problems and is not needed.
((EUID != 0)) || m365_die \
  'Run this script as your normal desktop user, WITHOUT sudo. The script invokes sudo itself only for apt dependencies.'

if ((!ASSUME_YES)); then
  [[ -t 0 ]] || m365_die 'Non-interactive input: pass --yes or run in a terminal.'
  read -r -p 'Continue? [y/N] ' answer
  [[ "$answer" =~ ^[yY]([eE][sS])?$ ]] || {
    printf 'Cancelled.\n'
    exit 0
  }
fi

STATE=${M365_LOCAL_STATE_DIR:-$HOME/.m365-copilot-local}
# Do not reject by mere file existence. The shared guard below validates the
# owner (PID + boot/start identity) and reclaims only verified stale metadata.

# Refuse arbitrary existing directories, conflicting commands and symlinks.
if [[ -e "$PREFIX" ]]; then
  [[ -d "$PREFIX" && -O "$PREFIX" ]] \
    || m365_die 'The prefix must be a directory owned by your user.'

  if [[ -n $(find "$PREFIX" -mindepth 1 -maxdepth 1 -print -quit) ]]; then
    [[ -f "$PREFIX/.m365proxy-install" &&
       $(cat "$PREFIX/.m365proxy-install") == m365proxy-user-install-v1 ]] \
      || m365_die 'Non-empty prefix does not belong to this installer; refusing to overwrite it.'
  fi
fi

if [[ -e "$BIN_DIR/m365proxy" || -L "$BIN_DIR/m365proxy" ]]; then
  [[ -L "$BIN_DIR/m365proxy" &&
     $(readlink -- "$BIN_DIR/m365proxy") == "$PREFIX/bin/m365proxy" ]] \
    || m365_die 'An unrelated m365proxy command already exists in the bin directory.'
fi

mkdir -p -- "$PREFIX" "$BIN_DIR"
[[ -w "$BIN_DIR" ]] \
  || m365_die 'The bin directory is not writable by your user. Choose a user-owned directory such as ~/.local/bin.'

chmod 700 -- "$PREFIX"
printf 'm365proxy-user-install-v1\n' > "$PREFIX/.m365proxy-install"

# -----------------------------------------------------------------------------
# System dependencies
# -----------------------------------------------------------------------------

if ((SYSTEM_DEPS)); then
  command -v sudo >/dev/null \
    || m365_die 'sudo is missing. Install the required OS dependencies as an administrator, then rerun with --no-system-deps.'

  m365_note 'Installing OS prerequisites. Only this stage uses sudo.'
  sudo -v
  sudo apt-get update

  # util-linux supplies flock on Debian-like systems.
  base=(
    ca-certificates
    curl
    git
    tar
    xz-utils
    build-essential
    python3
    pkg-config
    libsecret-1-dev
    util-linux
  )

  pkg_text=$(m365_chromium_packages) \
    || m365_die 'One or more Chromium libraries have no apt candidate. Check enabled repositories, or install compatible packages manually and rerun with --no-system-deps.'

  mapfile -t browser_packages <<< "$pkg_text"

  sudo apt-get install -y --no-install-recommends \
    "${base[@]}" \
    "${browser_packages[@]}"
fi

# Tools needed after the dependency stage.
for tool in curl git tar xz sha256sum awk flock; do
  command -v "$tool" >/dev/null \
    || m365_die "Missing required tool: $tool. Install system prerequisites and retry."
done

# -----------------------------------------------------------------------------
# Installer lock
# -----------------------------------------------------------------------------

exec 9> "$PREFIX/.install.lock"
flock -n 9 || m365_die 'Another installer is already running for this prefix.'

TEMP=''
RELEASE=''
ACTIVATED=0
STATE_GUARD_PID=''
STATE_GUARD_READ=''
STATE_GUARD_WRITE=''

cleanup() {
  local code=$?
  if [[ -n "$STATE_GUARD_WRITE" ]]; then
    exec {STATE_GUARD_WRITE}>&- || true
  fi
  if [[ -n "$STATE_GUARD_READ" ]]; then
    exec {STATE_GUARD_READ}<&- || true
  fi
  if [[ -n "$STATE_GUARD_PID" ]]; then
    wait "$STATE_GUARD_PID" || true
  fi

  [[ -z "$TEMP" ]] || rm -rf -- "$TEMP"

  if ((code != 0)); then
    printf '\nInstallation failed; existing Microsoft account data was left untouched.\n' >&2
    if [[ -n "$RELEASE" && "$ACTIVATED" == 0 ]]; then
      printf 'Unactivated release retained for diagnosis: %s\n' "$RELEASE" >&2
    fi
  fi
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

mkdir -p -- \
  "$PREFIX/runtime" \
  "$PREFIX/releases" \
  "$PREFIX/bin" \
  "$PREFIX/browsers"

TEMP=$(mktemp -d "$PREFIX/.download.XXXXXXXX")

# -----------------------------------------------------------------------------
# Node.js
# -----------------------------------------------------------------------------

if ((SYSTEM_NODE)); then
  command -v node >/dev/null && command -v npm >/dev/null \
    || m365_die '--use-system-node requires both node and npm on PATH.'

  NODE=$(node -p 'process.execPath')

  "$NODE" -e '
    const major = Number(process.versions.node.split(".")[0]);
    if (!Number.isFinite(major) || major < 24) process.exit(1);
  ' || m365_die 'Existing Node is older than 24.'
else
  m365_note 'Downloading the official Node 24 checksum manifest over HTTPS.'

  if [[ "$NODE_VERSION" == latest ]]; then
    dist='https://nodejs.org/download/release/latest-v24.x'
  else
    dist="https://nodejs.org/download/release/v$NODE_VERSION"
  fi

  curl \
    --fail \
    --show-error \
    --silent \
    --location \
    --retry 3 \
    --connect-timeout 20 \
    --max-time 300 \
    --proto '=https' \
    --proto-redir '=https' \
    "$dist/SHASUMS256.txt" \
    -o "$TEMP/SHASUMS256.txt"

  entry=$(m365_checksum_entry "$TEMP/SHASUMS256.txt" "$ARCH" "$NODE_VERSION") \
    || m365_die 'Node checksum manifest did not contain exactly one matching Node 24 Linux archive.'

  read -r expected archive <<< "$entry"

  node_version=${archive#node-v}
  node_version=${node_version%-linux-*}
  RUNTIME="$PREFIX/runtime/node-v$node_version-linux-$ARCH"

  if [[ ! -x "$RUNTIME/bin/node" ||
        ! -f "$RUNTIME/.archive-sha256" ||
        $(cat "$RUNTIME/.archive-sha256" 2>/dev/null) != "$expected" ]]; then

    [[ ! -e "$RUNTIME" ]] \
      || m365_die "Existing private runtime is incomplete or has a different checksum. Move it aside and retry: $RUNTIME"

    m365_note "Installing private Node v$node_version. System Node remains unchanged."

    curl \
      --fail \
      --show-error \
      --silent \
      --location \
      --retry 3 \
      --connect-timeout 20 \
      --max-time 1800 \
      --proto '=https' \
      --proto-redir '=https' \
      "https://nodejs.org/download/release/v$node_version/$archive" \
      -o "$TEMP/$archive"

    (
      cd "$TEMP"
      printf '%s  %s\n' "$expected" "$archive" | sha256sum --check --status -
    ) || m365_die 'Node archive checksum verification failed.'

    mkdir "$TEMP/runtime"

    tar \
      --extract \
      --xz \
      --file "$TEMP/$archive" \
      --directory "$TEMP/runtime" \
      --strip-components=1 \
      --no-same-owner

    printf '%s\n' "$expected" > "$TEMP/runtime/.archive-sha256"

    "$TEMP/runtime/bin/node" -e '
      if (Number(process.versions.node.split(".")[0]) !== 24) process.exit(1);
    ' || m365_die 'Downloaded Node 24 cannot run on this system.'

    mv -- "$TEMP/runtime" "$RUNTIME"
  fi

  NODE="$RUNTIME/bin/node"
fi

export PATH="$(dirname -- "$NODE"):$PATH"
export PLAYWRIGHT_BROWSERS_PATH="$PREFIX/browsers"
export PLAYWRIGHT_SKIP_BROWSER_GC=1

# Hold the state guard across build and activation. EOF on this private pipe
# also releases it if the installer is interrupted or killed.
m365_note 'Checking the process/profile owner and acquiring the shared state lock.'
coproc M365_STATE_GUARD { exec "$NODE" "$SOURCE/scripts/state-lock.mjs" "$STATE"; }
STATE_GUARD_PID=$M365_STATE_GUARD_PID
STATE_GUARD_READ=${M365_STATE_GUARD[0]}
STATE_GUARD_WRITE=${M365_STATE_GUARD[1]}
if ! IFS= read -r -t 15 -u "$STATE_GUARD_READ" state_guard_reply || [[ "$state_guard_reply" != READY ]]; then
  m365_die 'Cannot acquire the state directory. Close an active proxy/dedicated browser; verified stale PID locks are recovered automatically.'
fi

# -----------------------------------------------------------------------------
# Prepare a new release without touching active account/session state
# -----------------------------------------------------------------------------

RELEASE=$(mktemp -d "$PREFIX/releases/release-$(date -u +%Y%m%dT%H%M%SZ)-XXXXXXXX")

items=(
  src
  scripts
  tests
  examples
  docs
  package.json
  UPSTREAM.json
  README.md
  LICENSE
  THIRD_PARTY_NOTICES.md
  TEST_REPORT.md
  .gitignore
  install.sh
)

if [[ $(
  "$NODE" -p \
    'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).bundledInThisZip === true' \
    "$SOURCE/UPSTREAM.json"
) == true ]]; then
  items+=(vendor/cramt UPSTREAM_FILES_SHA256.json)
fi

# Explicit source allowlist and secret/state exclusions.
tar \
  --directory "$SOURCE" \
  --exclude=node_modules \
  --exclude=.git \
  --exclude=browser-profile \
  --exclude=api-key \
  --exclude=guided.json \
  --exclude='.guided-*.tmp' \
  --exclude=process.lock \
  --exclude=process.guard \
  --exclude=.env \
  --exclude='*.log' \
  --exclude='*.zip' \
  --exclude=secrets.json \
  --exclude=msal-cache.json \
  -cf - \
  "${items[@]}" \
  | tar --directory "$RELEASE" --no-same-owner -xf -

printf '%s\n' "$NODE" > "$RELEASE/.node-path"

# -----------------------------------------------------------------------------
# Build proxy + install/check Playwright Chromium
# -----------------------------------------------------------------------------

m365_note 'Fetching pinned cramt source, installing its lockfile and building as your user.'
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

# The shared state guard remains held until cleanup, including activation.
kill -0 "$STATE_GUARD_PID" 2>/dev/null \
  || m365_die 'The state-lock helper exited unexpectedly. Refusing to activate this release.' 

# -----------------------------------------------------------------------------
# PATH + activation
# -----------------------------------------------------------------------------

if ((EDIT_PATH)); then
  "$NODE" "$RELEASE/scripts/linux-path.mjs" add "$BIN_DIR"
fi

# Atomic launcher/current updates on the same filesystem.
install -m 700 -- \
  "$RELEASE/scripts/linux/launcher.sh" \
  "$PREFIX/bin/.m365proxy.new"

mv -f -- \
  "$PREFIX/bin/.m365proxy.new" \
  "$PREFIX/bin/m365proxy"

ln -s -- "$RELEASE" "$PREFIX/.current-new-$$"
mv -Tf -- "$PREFIX/.current-new-$$" "$PREFIX/current"
ACTIVATED=1

if [[ ! -L "$BIN_DIR/m365proxy" ]]; then
  ln -s -- "$PREFIX/bin/m365proxy" "$BIN_DIR/m365proxy"
fi

if [[ ! -e "$BIN_DIR/m365prox" && ! -L "$BIN_DIR/m365prox" ]]; then
  ln -s -- "$PREFIX/bin/m365proxy" "$BIN_DIR/m365prox"
elif [[ ! -L "$BIN_DIR/m365prox" || $(readlink -- "$BIN_DIR/m365prox") != "$PREFIX/bin/m365proxy" ]]; then
  m365_warn 'Existing unrelated m365prox command left unchanged. Use m365proxy menu.'
fi

"$BIN_DIR/m365proxy" --help

printf '\nInstallation completed for user %s.\n' "$(id -un)"
printf 'Distribution gating was capability-based, not name/version-based.\n'
printf '\nActivate the command in THIS terminal, or open a new terminal:\n\n'
printf '  export PATH=%q:"$PATH"\n' "$BIN_DIR"
printf '\nThen run:\n'
printf '  m365proxy menu   # or: m365proxy guided\n'
printf '  m365proxy key   # from another terminal\n\n'
printf 'Endpoint: http://127.0.0.1:8787/v1\n'
printf 'No Microsoft session has been tested by this installer.\n'

if [[ -z ${DISPLAY:-} && -z ${WAYLAND_DISPLAY:-} ]]; then
  m365_warn 'No graphical desktop display detected. First Microsoft login/MFA requires a graphical session.'
fi
