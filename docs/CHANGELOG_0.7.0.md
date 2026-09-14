# 0.7.0 - Named Profiles and Conversation Continuity

## Named Profiles

- Added private profile storage under `profiles/<name>.json`.
- Creating a profile does not overwrite existing profiles with the same name.
- Management CLI: `profile list`, `show`, `run`, `clone`, and `delete`.
- Non-destructive migration of legacy `guided.json` to `default`.

## Conversation Reuse

- `--conversation-mode reuse` enabled by default; `fresh` preserves previous per-request session creation.
- Configurable TTL, max active sessions, and turn limits.
- In `upload`/`hybrid` modes, unchanged attachments are cached within the persistent tab across turns.
- In-memory conversation state resets on proxy process restart or account change.
