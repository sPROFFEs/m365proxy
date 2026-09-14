> **0.8.0:** Default context policy is `adaptive`: general questions can use 0 attachments. Experimental script bridge `--exec-mode script` is documented in [EXPERIMENTAL_EXEC.md](EXPERIMENTAL_EXEC.md) and disabled by default.
>
> **0.8.0:** Named profiles and safe conversation reuse are available. See [PROFILES_AND_SESSIONS.md](PROFILES_AND_SESSIONS.md).
>
> **0.5.1:** `m365proxy menu` and `guided` simplify configuration. Optional `m365prox` alias.

# Linux Installation Guide

## Quick Start

From the extracted package, run as your normal desktop user (not root):

```bash
cd m365-copilot-local
bash install.sh
export PATH="$HOME/.local/bin:$PATH"
m365proxy
```

In a separate terminal:

```bash
m365proxy key
```

Configure your client to use `http://127.0.0.1:8787/v1`, model `m365-copilot`, and the Bearer API key output from `m365proxy key`. Keep the dedicated browser window open while using the proxy. Complete sign-in / MFA, and send a short message in Copilot if Chathub is not captured immediately.

## Supported Platforms and Privileges

The installer supports x86_64/amd64 and arm64/aarch64 Linux systems without hardcoded distribution allowlists. Debian, Kali, Parrot, Ubuntu, Linux Mint, and other Debian-family distributions with `apt-get` and `apt-cache` are supported automatically.

On non-APT distributions, install browser dependencies manually and run `bash install.sh --no-system-deps`.

The installer script rejects `sudo bash install.sh`. Run without `sudo`; the script invokes `sudo` only for APT package installation when system libraries are missing.

## Installation Layout

```text
~/.local/share/m365proxy/
  .m365proxy-install          installer verification marker
  .install.lock               installer exclusion lock
  runtime/node-v24.../        private Node.js + npm runtime
  browsers/                   Playwright Chromium binary
  releases/release-.../       proxy code, vendor/cramt, dependencies, and build
  current -> releases/.../    active release symlink
  bin/m365proxy               executable launcher

~/.local/bin/m365proxy -> ~/.local/share/m365proxy/bin/m365proxy

~/.m365-copilot-local/        private proxy state directory
  api-key                     local Bearer API key (0600)
  browser-profile/            Playwright browser session
  process.lock                PID & boot identity lock metadata
  process.guard               kernel flock lock anchor
```

The installer verifies the Node 24 archive SHA-256 against official nodejs.org releases.

## APT Dependencies

When needed, the installer installs required build tools and Chromium runtime libraries:

```text
ca-certificates curl git tar xz-utils build-essential python3 pkg-config libsecret-1-dev
libasound2 libatk1.0-0 libatk-bridge2.0-0 libatspi2.0-0 libcups2 libglib2.0-0 libgtk-3-0
libnss3 libnspr4 libdbus-1-3 libdrm2 libexpat1 libgbm1 libpango-1.0-0 libcairo2
libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 libxkbcommon0
libxrandr2 libxshmfence1 libxss1 libx11-xcb1 libpangocairo-1.0-0
fonts-liberation fonts-noto-color-emoji xdg-utils
```

## CLI Commands

```bash
m365proxy                      # alias for serve (foreground)
m365proxy menu                 # interactive guided menu
m365proxy guided               # step-by-step profile wizard
m365proxy profile list         # list saved named profiles
m365proxy profile show <NAME>  # show profile configuration
m365proxy profile run <NAME>   # run a named profile
m365proxy login                # opens browser for authentication
m365proxy key                  # prints local API key
m365proxy status --port 1234   # queries proxy health and status
m365proxy probe --port 1234    # sends a test request
m365proxy doctor               # validates Node runtime & browser
m365proxy check-browser        # headless browser launch test
m365proxy unlock               # recovers stale dead process locks
```

## Uninstallation

Stop any running proxy instance. Remove the application binaries and directories:

```bash
PREFIX="${XDG_DATA_HOME:-$HOME/.local/share}/m365proxy"
NODE="$(cat "$PREFIX/current/.node-path")"
"$NODE" "$PREFIX/current/scripts/linux-path.mjs" remove
rm -- "$HOME/.local/bin/m365proxy"
rm -rf -- "$PREFIX"
```

To permanently remove saved browser sessions and API keys, delete `~/.m365-copilot-local`.
