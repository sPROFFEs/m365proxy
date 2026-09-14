# M365 Copilot Local 0.9.0

Stable local OpenAI-compatible proxy for Microsoft 365 Copilot Web with browser authentication, named profiles, and optional workspace access.

## 0.9.0: Stability Over Heuristics

The architecture has been streamlined into three recommended modes. The default setup wizard mode is **FULL WORKSPACE**:

1. **FULL WORKSPACE [Recommended]**: The model can inspect/modify the workspace and execute commands via the local script bridge. All requests use direct Chathub. The proxy never switches to the web uploader based on prompt keywords.
2. **WORKSPACE READ-ONLY [Stable]**: Selected workspace context injected into the prompt over direct Chathub; no file writes or command execution.
3. **CHAT ONLY**: Pure chat proxy without filesystem access.
4. **ADVANCED / LEGACY**: Preserves upload/hybrid, auto-write, and experimental lab options.

The core rule is: **each profile configuration follows a deterministic transport route**. EXEC never uses the browser composer. Browser upload remains isolated to non-EXEC profiles that explicitly enable it.

## Installation

```bash
unzip m365-copilot-local-linux-v0.9.0.zip
cd m365-copilot-local
bash install.sh
export PATH="$HOME/.local/bin:$PATH"
m365proxy menu
```

Run `install.sh` as your normal desktop user, not with `sudo`. The script uses `sudo` only when system package dependencies are missing.

## Recommended Configuration

```bash
m365proxy guided
```

Select **1 FULL WORKSPACE [RECOMMENDED]**, choose the workspace folder, and save a profile. The equivalent command-line flags are:

```bash
m365proxy \
  --port 1234 \
  --workspace /path/to/project \
  --context-mode read \
  --context-policy adaptive \
  --conversation-mode reuse \
  --write-mode off \
  --exec-mode script \
  --exec-max-steps 6 \
  --exec-timeout-ms 30000 \
  --tool-mode guarded \
  --timeout-ms 300000
```

In FULL WORKSPACE mode, the model receives a local capability rather than an automatic whole-repo upload. When a task depends on actual file state, the proxy enforces a bounded local inspection/action turn before accepting a final answer. Temporary scripts run under the same user privileges that launched `m365proxy` (not sandboxed).

## Client Connection

```text
Base URL: http://127.0.0.1:1234/v1
Model:    m365-copilot
API key:  output of `m365proxy key`
```

Wait until you see `[AUTH] SESSION CAPTURED` in the proxy logs before sending client requests.

## Profiles

```bash
m365proxy profile list
m365proxy profile show NAME
m365proxy profile run NAME
m365proxy profile clone SOURCE NEW_NAME
m365proxy profile delete NAME
```

## Changes in 0.9.0

- EXEC always uses `direct_chathub`; there is no automatic fallback to `browser_with_attachments`.
- FULL WORKSPACE does not scan/upload all files before every request. The filesystem is inspected on demand by scripts.
- A malformed `m365-exec` block receives a single bounded repair turn before failing cleanly; no infinite retry loops.
- Permissive execution aliases (`command`/`code`, `shell`, descriptive metadata) are accepted safely without widening executable content.
- Tasks about project/host state answered without observing real files trigger a bounded local inspection enforcement turn.
- The `browser-upload` flow for non-EXEC profiles returns to the proven stable implementation prior to composer workarounds.
- The interactive menu starts with simplified presets; upload/hybrid and auto-write are located under Advanced.

## Limitations

Microsoft 365 Copilot Web does not offer a public native function calling API. FULL WORKSPACE emulates an agent through an explicit textual script contract + local execution + feedback loops within the same Chathub conversation. This functions more like managed tool emulation than native backend tool calling.

Execution mode does not prompt for per-command confirmation. It maintains bounds on maximum steps, timeout, and output size, but scripts execute with the user's process privileges.

Upload and hybrid modes remain available in Advanced and may depend on Microsoft UI layout changes. Copilot Web allows a maximum of 3 attachments per message; the proxy automatically splits larger selections into multi-turn messages within the same chat.

## Diagnostics

```bash
m365proxy status --port 1234
m365proxy probe --port 1234
m365proxy doctor
```

Each request logs its `route_plan`, for example:

```text
route_plan mode=full_workspace transport=direct_chathub context_decision=exec_capability
```

This verifies that a conversation is not silently switching transports or backends.

See [docs/ARCHITECTURE_0.9.0.md](docs/ARCHITECTURE_0.9.0.md), [docs/CHANGELOG_0.9.0.md](docs/CHANGELOG_0.9.0.md), and [docs/EXPERIMENTAL_EXEC.md](docs/EXPERIMENTAL_EXEC.md).
