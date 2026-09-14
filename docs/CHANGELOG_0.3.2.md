# 0.3.2 - OpenCode Compatibility and Process Lifecycle

## Routes and Protocols

- Native Ollama text endpoint: `POST /api/chat`, `GET /api/tags`, `POST /api/show`, `GET /api/version` using NDJSON streaming and `done: true`.
- Exact route aliases for common SDK Base URL conventions.
- Bearer API key authentication enforced across all routes.
- Structured request logging without exposing query strings, tokens, or prompt bodies.

## Process Shutdown and Lock Recovery

- Clean signal handling for `SIGINT`, `SIGTERM`, and `SIGHUP`.
- Linux kernel `flock` and verified PID lock metadata (`process.lock` and `process.guard`).
- Automatic stale lock recovery after `SIGKILL` or system crashes without blind file deletion.
