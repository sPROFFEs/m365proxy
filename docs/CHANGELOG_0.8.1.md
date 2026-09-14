# 0.8.1 - Native Directory Creation in Auto-Write

## Changes

- The `m365proxy.edit.v1` contract supports `{"action": "mkdir", "path": "..."}`.
- Normalizes empty `<directory>/.gitkeep` write requests into directory creation (`mkdir`) without creating unnecessary placeholder files.
- The change journal records directory creation and safely removes empty directories during `undo` without recursive deletion.
