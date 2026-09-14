# Historical Documentation: Release 0.4.0

> Current documentation and startup guides are in the repository root `README.md` and `docs/UPLOAD_GUIDED.md`.

# M365 Copilot Local 0.4.0

Local OpenAI-compatible proxy for Microsoft 365 Copilot Web with Playwright browser session management and emulated tool calling.

- Pinned upstream revision: `d7c6d8080bf2bb769c1949c2dfbe60bb7ca929c3`.
- Added workspace context snapshotting (`--workspace`, `--workspaces`) and proposal-only patch checking (`m365proxy propose`, `m365proxy patch-check`).
- Support for OpenAI Chat Completions, Responses API, and native Ollama `/api/chat` protocols.
- Structured timeout enforcement, disposable worker threads, and atomic PID/flock lifecycle guards.
