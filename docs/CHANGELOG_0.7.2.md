# 0.7.2 - Empty Files and Metadata-Only Inventory

## Changes

- 0-byte local workspace files are included in the snapshot as `metadata_only_empty` and never passed to the native upload input.
- If an empty file gains content on disk, it is uploaded normally as a new version on the next turn.
- `write-mode auto` can modify or delete selected empty files based on known baseline metadata.
- Inventory queries (`how many files`, `project structure`, etc.) construct metadata-only turns without forced attachments.
- Manifest exposes `eligible_source_files`, `inventory_complete`, and `metadata_only_request`.
