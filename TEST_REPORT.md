# Test Report - 0.9.0

Focuses on regression testing and deterministic transport routing.

- Node.js test suite: 368 total unit and integration tests.
- 367 pass, 0 fail, 1 skipped (offline authoring environment skip for live upstream download).

Key coverage areas:

- EXEC never falls back to browser transport even on legacy hybrid configurations.
- FULL WORKSPACE prepare bypasses full source scanning.
- `m365-exec` contract parsing with safe aliases.
- Bounded repair for malformed EXEC contracts.
- Bounded single-turn local grounding inspection enforcement for host/project tasks.
- Regression verification for browser uploader.
- Named profiles, process locks, request queue, auto-write journaling, Responses API, Chat Completions, and native Ollama adapter.
