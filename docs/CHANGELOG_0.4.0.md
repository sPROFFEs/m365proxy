# 0.4.0 - Local Code Workspace Context and Proposal-Only Patch Mode

## Opt-In Workspace Context

- `--workspace PATH` configures a single workspace root; `--workspaces FILE` configures multi-project registries up to 16 roots.
- Scoped routing via `/projects/<ID>/v1` Base URLs or `X-M365-Project` headers.
- Request-time lexical snapshot scanning honoring `.gitignore` and `.m365ignore`.
- Secure Linux descriptor reads without shell calls.

## Modes

- `read`: Injects selected whole file context into prompts while preserving client tool calling and agency.
- `patch`: Proposal-only mode. Validates unified diffs against baseline file hashes and returns HMAC-signed proposal bundles without modifying files on disk.
- CLI commands `propose` and `patch-check`.
