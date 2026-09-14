# 0.8.0 - Adaptive Context Policy and Experimental Script Bridge

## Adaptive Context

- `--context-policy adaptive` is the default policy.
- General questions do not select or attach files merely because a workspace is configured.
- Inventory queries use metadata-only snapshots.
- When `exec-mode=script` detects a host command, `local_action_no_source` prevents uploading code that scripts can inspect locally.
- `--context-policy always` preserves previous per-turn attachment behavior.
- `.m365proxy-tmp` is protected from workspace readers and scanners.

## Experimental Execution Bridge

- Added `--exec-mode off|script`.
- Copilot proposes single `m365-exec` script blocks per step.
- The proxy executes scripts inside `<workspace>/.m365proxy-tmp/session-...` with cwd set to the workspace root, captures stdout/stderr, and returns outputs to the same Copilot conversation.
- Configurable step limits (`--exec-max-steps`), timeouts, and output bounds.
- Temporary scripts deleted immediately after run; session directories removed on clean shutdown.
- `exec-mode=script` and `write-mode=auto` are mutually exclusive.
