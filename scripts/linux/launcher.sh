#!/usr/bin/env bash
# Installed as PREFIX/bin/m365proxy, linked from ~/.local/bin/m365proxy.
set -Eeuo pipefail
umask 077
SCRIPT=$(readlink -f -- "${BASH_SOURCE[0]}")
PREFIX=$(cd -- "$(dirname -- "$SCRIPT")/.." && pwd -P)
APP=$(readlink -f -- "$PREFIX/current")
help() {
  cat <<'HELP'
m365proxy - local Microsoft 365 Copilot / OpenAI adapter

Usage: m365proxy [command] [options]

  (no command)          Start the proxy and visible authentication browser.
  serve | start         Same as above. Stop with Ctrl+C.
  menu                  Interactive setup, named profiles, status and recovery.
  guided                Create a named configuration step by step.
  profile               list|show|run|clone|delete named configurations.
  profiles              Alias for profile list.
  login                 Prepare the dedicated browser profile with manual login/MFA.
  key                   Print ONLY the local API key.
  doctor                Check Node, cramt build and Playwright package.
  status                Query authenticated /health (does not start the proxy).
  probe                 Test one short text request, no tools or retries.
  context               Preview selected workspace paths/hashes (no inference).
  propose               Request a text patch proposal; --prompt-file FILE.
  patch-check           Validate --proposal FILE; never applies the patch.
  ask                   One request via --query TEXT or --prompt-file FILE.
  changes               List local automatic write receipts/backups.
  undo                  Restore --change-id ID, with version checks, no prompt.
  unlock                Verify/recover a stale PID lock; never kills a live process.
  check-browser         Open and close a headless about:blank page (no Microsoft).
  repair                Re-run pinned upstream setup; does not install apt packages.
  demo-tools            Run the client-side echo tool-call demonstration.
  version               Show the installed extension version.
  help                  Show this message.

Examples:
  m365proxy menu
  m365proxy guided
  m365proxy
  m365proxy --port 8788
  m365proxy serve --headless
  m365proxy login --channel msedge
  m365proxy key --state-dir /absolute/private/state

Options are forwarded to the proxy: --port, --state-dir, --channel, --headless,
--model, --tool-mode, --compat, --strict, --repair-attempts, --timeout-ms,
--first-token-timeout-ms, --idle-timeout-ms, --workspace PATH, --workspaces FILE,
--workspace-id ID, --context-mode read|patch|upload|hybrid,
--context-policy adaptive|always, --context-max-bytes,
--context-max-files, --context-max-file-bytes, --context-scan-timeout-ms,
--upload-max-files, --upload-max-file-size, --upload-max-bytes,
--upload-timeout-ms, --upload-ui-config FILE, --write-mode off|auto,
--exec-mode off|script, --exec-max-steps N, --exec-timeout-ms N,
--exec-output-bytes N,
--queue-size N, --queue-timeout-ms N, --conversation-mode reuse|fresh,
--conversation-ttl-ms N, --conversation-max N, --conversation-max-turns N,
--change-id ID, --project ID, --query TEXT, --prompt-file FILE, --output FILE and --proposal FILE.

API: http://127.0.0.1:8787/v1 ; model: m365-copilot
Chat Completions and Responses use SSE; native Ollama /api/chat uses NDJSON.
Compatibility mode is default; all routes require the local Bearer API key.
Auto-write saves within the registered workspace without per-edit confirmation.
Experimental exec-mode=script is a separate unsandboxed opt-in that runs model-
proposed temporary scripts as the proxy OS user with no per-command confirmation.
Both owner modes disable client tools and cannot be combined. Context policy
adaptive avoids source uploads on unrelated questions. Conversation reuse is the
default; exact history continuations keep the same remote chat.
No daemon is installed. Browser sign-in/MFA remains interactive.
HELP
}
cmd=${1:-serve}
case "$cmd" in
  -h|--help|help) help; exit 0 ;;
  --version) cmd=version; shift ;;
  --*) cmd=serve ;;  # Keep flags, including relative --state-dir paths.
  *) (($# == 0)) || shift ;;
esac
[[ -f "$APP/.node-path" ]] || { printf 'Installation incomplete: reinstall from the ZIP.\n' >&2; exit 1; }
IFS= read -r NODE < "$APP/.node-path"
[[ -x "$NODE" ]] || { printf 'Configured Node is missing. Re-run install.sh.\n' >&2; exit 1; }
export PATH="$(dirname -- "$NODE"):$PATH"
export PLAYWRIGHT_BROWSERS_PATH="$PREFIX/browsers"
export PLAYWRIGHT_SKIP_BROWSER_GC=1
if [[ "$cmd" == version ]]; then
  exec "$NODE" --input-type=module -e 'import{readFileSync}from"node:fs";console.log("m365proxy "+JSON.parse(readFileSync(process.argv[1],"utf8")).version)' "$APP/package.json"
fi
((EUID != 0)) || { printf 'Run m365proxy as your normal desktop user, NOT with sudo.\n' >&2; exit 1; }
[[ "$cmd" != start ]] || cmd=serve
case "$cmd" in
  serve|login)
    headless=0
    for arg in "$@"; do [[ "$arg" != --headless ]] || headless=1; done
    if [[ "$headless" == 0 && -z ${DISPLAY:-} && -z ${WAYLAND_DISPLAY:-} ]]; then
      printf 'No graphical display. Run from your desktop for login/MFA.\nUse --headless only when the profile is already signed in.\n' >&2
      exit 1
    fi
    exec "$NODE" "$APP/src/cli.mjs" "$cmd" "$@" ;;
  menu|guided|profile|profiles|key|doctor|status|probe|unlock|context|propose|patch-check|ask|changes|undo) exec "$NODE" "$APP/src/cli.mjs" "$cmd" "$@" ;;
  check-browser) exec "$NODE" "$APP/scripts/browser-setup.mjs" check "$@" ;;
  repair) exec "$NODE" "$APP/scripts/bootstrap.mjs" "$@" ;;
  demo-tools) exec "$NODE" "$APP/examples/tool-loop.mjs" "$@" ;;
  *) printf 'Unknown command: %s. Run m365proxy help.\n' "$cmd" >&2; exit 2 ;;
esac
