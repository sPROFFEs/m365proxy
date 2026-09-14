# 0.9.0 - Architecture Stabilization

- FULL WORKSPACE transitions to direct Chathub for all turns, even if the legacy profile was `hybrid`.
- The EXEC path stops scanning and pre-selecting source files before each request; uses a minimal capability snapshot.
- Browser upload is strictly isolated to non-EXEC profiles.
- Restores the proven browser-upload driver prior to 0.8.x composer workarounds to prevent regressions in non-script profiles.
- Adds single-turn bounded repair for malformed `m365-exec` blocks.
- Execution parser accepts safe aliases: `command`/`code`, `shell`, `python3`, `pwsh`, and descriptive metadata.
- Tasks depending on workspace/host state that do not execute an inspection turn receive a single bounded grounding enforcement turn.
- Adds `route_plan` diagnostic logs and `runtime_mode`/`transport` response metadata.
- Streamlines guided setup to FULL WORKSPACE, WORKSPACE READ-ONLY, CHAT ONLY, and ADVANCED / LEGACY.
- FULL WORKSPACE is the recommended default for new profiles.
