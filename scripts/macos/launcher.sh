#!/usr/bin/env bash
# Installed as PREFIX/bin/m365proxy and linked from ~/.local/bin/m365proxy.
set -euo pipefail
umask 077

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
PREFIX=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd -P)
CURRENT="$PREFIX/current"
[[ -e "$CURRENT" ]] || { printf 'Installation incomplete: current release is missing. Reinstall m365proxy.\n' >&2; exit 1; }
APP=$(CDPATH= cd -- "$CURRENT" && pwd -P)
[[ -f "$APP/.node-path" ]] || { printf 'Installation incomplete: .node-path is missing. Reinstall m365proxy.\n' >&2; exit 1; }
IFS= read -r NODE < "$APP/.node-path"
[[ -x "$NODE" ]] || { printf 'Configured Node is missing. Re-run install-macos.sh.\n' >&2; exit 1; }

export PATH="$(dirname -- "$NODE"):$PATH"
export PLAYWRIGHT_BROWSERS_PATH="$PREFIX/browsers"
export PLAYWRIGHT_SKIP_BROWSER_GC=1

cmd=${1:-serve}
case "$cmd" in
  -h|--help|help) exec "$NODE" "$APP/src/cli.mjs" help ;;
  --version|version)
    exec "$NODE" --input-type=module -e 'import{readFileSync}from"node:fs";console.log("m365proxy "+JSON.parse(readFileSync(process.argv[1],"utf8")).version)' "$APP/package.json" ;;
  --*) cmd=serve ;;
  *) (($# == 0)) || shift ;;
esac
[[ "$cmd" != start ]] || cmd=serve

if [[ $(id -u) -eq 0 ]]; then
  printf 'Run m365proxy as your normal desktop user, not as root.\n' >&2
  exit 1
fi

case "$cmd" in
  serve|login|menu|guided|profile|profiles|key|doctor|status|probe|unlock|context|propose|patch-check|ask|changes|undo)
    exec "$NODE" "$APP/src/cli.mjs" "$cmd" "$@" ;;
  check-browser)
    exec "$NODE" "$APP/scripts/browser-setup.mjs" check "$@" ;;
  repair)
    exec "$NODE" "$APP/scripts/bootstrap.mjs" "$@" ;;
  demo-tools)
    exec "$NODE" "$APP/examples/tool-loop.mjs" "$@" ;;
  *)
    printf 'Unknown command: %s. Run m365proxy help.\n' "$cmd" >&2
    exit 2 ;;
esac
