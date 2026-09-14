# 0.6.0 - Automatic File Writes, Request Queue, and Undo

- Added `--write-mode auto` per workspace root; multi-project JSON configuration supports `write_mode`.
- Introduces `m365-edit` structured response contract with full file contents, without `tool_calls` and without per-change confirmation. Supports UTF-8 file creation, updates, and deletion.
- Client-advertised tools are suppressed in auto-write mode with explicit metadata; prior tool history requires starting a fresh chat.
- Automatic verification of file hashes, versions, paths, and ignore policies; upload names are not used as local destination paths.
- Private local backups, durable HMAC change journals, atomic per-file replacement, and kernel flock on root directory. Reversible rollback with version checks.
- Endpoints `/local/changes` and `/local/changes/undo`, plus CLI commands `changes`, `undo`, and `ask`.
- Auto-write responses are buffered until disk write/rollback completes, appending a locally generated receipt.
- FIFO request queue: 4 pending slots, 240s wait timeout, cancellation support, and status reporting in `/health`.
- Persistent detection of identical replayed requests and `Idempotency-Key` support.
