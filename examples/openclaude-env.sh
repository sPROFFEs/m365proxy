#!/usr/bin/env bash
set -Eeuo pipefail
export CLAUDE_CODE_USE_OPENAI=1
export OPENAI_BASE_URL="${OPENAI_BASE_URL:-http://127.0.0.1:8787/v1}"
export OPENAI_API_KEY="${OPENAI_API_KEY:-$(m365proxy key)}"
export OPENAI_MODEL="${OPENAI_MODEL:-m365-copilot}"
exec openclaude "$@"
