> **0.8.1:** Auto-write supports real `mkdir` for empty directories and normalizes `<dir>/.gitkeep` placeholders into clean directory structures.
>
> **0.8.0:** Default context policy is `adaptive`: general questions can use 0 attachments. Experimental script bridge `--exec-mode script` is documented in [EXPERIMENTAL_EXEC.md](EXPERIMENTAL_EXEC.md) and disabled by default.
>
> **0.8.0:** Named profiles and safe conversation reuse are available. See [PROFILES_AND_SESSIONS.md](PROFILES_AND_SESSIONS.md).

# Automatic Workspace File Writes - m365proxy

## Overview

Auto-write establishes an end-to-end loop: local workspace folder -> context/attachments -> structured Copilot edit response -> local backup -> direct disk write -> receipt returned to CLI. No per-file, per-change, or per-turn interactive prompts are required. The user enables this capability via `--write-mode auto`; `off` remains the safe default. The file write mode is transport-independent: it functions with `read`, `upload`, or `hybrid` context modes. `patch` mode preserves its proposal-only behavior without writing.

The proxy DOES NOT execute shell commands, tests, builds, git commits, or external downloads in `write-mode auto`. Successful writes only confirm that files were saved to disk, not that the code is free of semantic bugs.

## 1. Updating & Installation

Stop any previous proxy instance with `Ctrl+C`. Extract and run the installer:

```bash
unzip m365-copilot-local-linux-v0.9.0.zip
cd m365-copilot-local
bash install.sh
export PATH="$HOME/.local/bin:$PATH"
m365proxy version
```

Run `install.sh` as your regular desktop user (not with `sudo`).

## 2. Guided Setup Wizard

```bash
m365proxy menu
```

Choose **1, Create new configuration**. Give the profile a unique name:

- Port: `1234`
- Browser: Chromium (visible for sign-in/MFA)
- Mode: `read` (or `hybrid` in Advanced)
- Workspace: `/path/to/project`
- **Local actions: `2 AUTO-WRITE`**

In auto-write mode, client tool-calling format is suppressed because the proxy acts as the sole write controller. Review the workspace preview, authorize sending context to Microsoft, and save the configuration.

Complete sign-in in the dedicated browser window. Wait for `[AUTH] SESSION CAPTURED`.

## 3. Direct Command-Line Flags

```bash
m365proxy --port 1234 \
  --workspace /path/to/project \
  --context-mode read \
  --write-mode auto
```

To revert to standard read-only tool-calling proxy mode, start with `--write-mode off` and start a new conversation in your client.

## 4. PrAImate, OpenClaude, and OpenCode Integration

Configure your OpenAI-compatible client:

```text
Base URL: http://127.0.0.1:1234/v1
Model:    m365-copilot
API key:  output of `m365proxy key`
```

**Start a NEW conversation** when switching between client-side tool execution and proxy auto-write. Auto-write mode ignores client-advertised tools and declares them under `x_m365.ignored_parameters` to prevent dual write controllers.

Prompt the assistant naturally, for example:

```text
Modify src/utils.js to add a helper function formatBytes(bytes).
Save the result while preserving the existing functionality.
Do not execute tests or make Git commits.
```

## 5. Verification & Change Receipts

Every auto-write response includes a receipt generated locally after files are written to disk:

```text
[m365proxy] Changes saved to host without interactive confirmation.
- updated: src/utils.js
Change ID: <UUID>. Previous version backed up to local proxy state.
No shell commands, tests, or Git commits were executed.
```

In JSON responses: `x_m365.workspace.write.applied` is `true`. Full metadata includes change ID, modified file paths, write actions, and SHA-256 hashes before and after modification. In streaming modes, completion events arrive only after all disk writes and backups succeed.

If the model produces plain prose or an illustrative snippet without an edit block, no files are modified, and the receipt indicates: `No local files were modified in this turn.`

## 6. CLI Testing via `ask`

With the server running and authenticated:

```bash
m365proxy status --port 1234
m365proxy ask --port 1234 --query 'Add a docstring to main() in src/app.py and save the file.'
```

For multiline prompts or scripts:

```bash
m365proxy ask --port 1234 --prompt-file "$HOME/task.txt"
```

## 7. Request Queue and Idempotency

The proxy processes one active turn at a time and buffers up to **4 pending requests** in a FIFO queue (`--queue-size 4`, `--queue-timeout-ms 240000`). Clients disconnecting while queued are removed without sending unneeded requests to Microsoft.

Completed writes store a fingerprint of the request context. An exact replay (identical messages, project, model, session, and idempotency key) reuses the existing receipt if on-disk files match the written version. Clients can send an `Idempotency-Key` header.

## 8. Backups, History, and Undo

In a separate terminal:

```bash
m365proxy changes --port 1234
m365proxy undo --port 1234 --change-id <CHANGE_ID>
```

`undo` restores backed-up files from the specified change and removes files created by it without requiring model inference.

Storage layout:

```text
~/.m365-copilot-local/changes/<workspace-hash>/<CHANGE_ID>/
  record.json    HMAC-signed change journal
  0.before       original bytes of first modified file
  1.before       original bytes of second modified file
  ...
```

Directories are set to `0700` and journal files to `0600`. Rotating or deleting the API key invalidates journal HMAC signatures.

## 9. Consistency and Safety Guarantees

Before modifying files, the proxy validates all file paths and hashes and backs up original versions. Existing file permissions are preserved; newly created files use `0644`. Files are updated using atomic file replacement (`rename`) and filesystem directory sync (`fsync`).

Path traversal, symlink attacks, special device files, protected ignore rules, non-UTF-8 content, and heuristic secrets are rejected before any writes take place.
