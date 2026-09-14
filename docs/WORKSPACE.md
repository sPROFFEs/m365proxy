> **0.8.0:** Default context policy is `adaptive`: general questions can use 0 attachments. Experimental script bridge `--exec-mode script` is documented in [EXPERIMENTAL_EXEC.md](EXPERIMENTAL_EXEC.md) and disabled by default.
>
> **0.8.0:** Named profiles and safe conversation reuse are available. See [PROFILES_AND_SESSIONS.md](PROFILES_AND_SESSIONS.md).

# Workspace Context and Patch Proposals

## Overview

The workspace reader builds an in-memory snapshot of local project files at request time. Relevant whole files are selected based on lexical matching, query terms, and configured byte limits. In `read` mode, this text is injected into the prompt sent to Copilot over direct Chathub. It does not create remote shares or background filesystem watchers.

Enabling `--workspace` or `--workspaces` authorizes sending selected file contents to Microsoft 365 Copilot during inference. Always review your project files with `m365proxy context` and configure `.m365ignore`.

## 1. Single Project Setup

```bash
# Preview selected context files without inference:
m365proxy context --workspace /path/to/project --query 'authentication logic'

# Start the proxy with read workspace context:
m365proxy --port 1234 --workspace /path/to/project --context-mode read
```

Configure your OpenAI-compatible client:

```text
Base URL: http://127.0.0.1:1234/v1
API key:  output of `m365proxy key`
Model:    m365-copilot
```

## 2. Multi-Project Registry

Copy `examples/workspaces.example.json` and configure absolute root paths:

```json
{
  "version": 1,
  "projects": [
    { "id": "backend", "root": "/home/user/projects/api", "mode": "read" },
    { "id": "backend-patch", "root": "/home/user/projects/api", "mode": "patch" }
  ]
}
```

Start with the registry file:

```bash
m365proxy --port 1234 --workspaces "$HOME/workspaces.json"
```

Clients target specific projects via scoped URLs:

```text
http://127.0.0.1:1234/projects/backend/v1
```

Or by including the `X-M365-Project: backend` header.

## 3. Proposal-Only Patch Mode

In `patch` mode (`--context-mode patch`), the model proposes unified diffs. The proxy validates format, line counts, and baseline hashes, but **does not apply diffs to disk**:

```bash
# Propose a patch to an explicit output JSON bundle:
m365proxy propose --port 1234 --project backend-patch \
  --prompt-file task.txt --output proposal.json

# Validate that the patch matches current disk files:
m365proxy patch-check --port 1234 --proposal proposal.json
```

Output JSON bundles are signed with HMAC using the local API key. `patch-check` verifies that on-disk files match the baseline versions without modifying any files.

## 4. Selection Limits and Exclusions

Defaults:

- Max files: 16 (`--context-max-files`)
- Max file size: 32,768 bytes (`--context-max-file-bytes`)
- Max total context: 65,536 bytes (`--context-max-bytes`)
- Scan timeout: 5,000 ms (`--context-scan-timeout-ms`)

### Exclusion Rules

The scanner automatically respects `.gitignore` rules in the root and subdirectories, plus `.m365ignore` in the project root.

Regardless of rules, the scanner hard-excludes:
- `.git/` directories
- `node_modules/`, `vendor/`, and dependency directories
- Build outputs (`dist/`, `build/`, `target/`)
- `.env*` files, credentials, and known secret patterns
- Binary files, symlinks, and hardlinks
- Internal proxy state (`~/.m365-copilot-local`)
