# Architecture 0.9.0

## Design Principle

Instability in 0.8.x stemmed from coupling three different mechanisms into dynamic per-prompt heuristics: direct Chathub, browser upload/composer, and local script execution. A single word such as `script`, `file`, or `analyze` could trigger a transport switch, discarding or branching the remote conversation identity.

0.9.0 establishes strict separation between runtime capabilities and underlying transports.

## FULL WORKSPACE

```text
OpenAI-compatible client
        |
        v
m365proxy normalizes request
        |
        v
capability snapshot (no full scan/upload)
        |
        v
direct Chathub / sticky EXEC session
        |
        +--> ordinary response ---------------------> client
        |
        +--> m365-exec proposal
               |
               v
          temporary script
               |
               v
          host/workspace execution
               |
               v
          stdout/stderr/exit code
               |
               v
          same Chathub session feedback
```

There is no dynamic branch to Playwright when files are referenced. Playwright remains active solely for session authentication and for explicit upload-mode profiles, never for FULL WORKSPACE.

## WORKSPACE READ-ONLY

Selects a bounded set of source files / text snippets and embeds them into the prompt sent over direct Chathub. No local code execution.

## CHAT ONLY

Uses direct Chathub exclusively and does not interact with any workspace filesystem.

## ADVANCED / LEGACY

Preserves upload/hybrid and auto-write modes for backward compatibility and experimental setups. Browser upload remains strictly isolated from EXEC.

## Bounded EXEC Loop

Each model response is evaluated as follows:

1. If no `m365-exec` block is present, the output is treated as a standard text response.
2. If a valid execution contract block is found, a single local script step is executed.
3. The execution output is fed back into the exact same remote Chathub session.
4. Bound by a configurable maximum step count per request (`--exec-max-steps`, default 4-6).
5. A malformed contract block receives at most one bounded automated repair turn.
6. If a task requires real local state but the model attempts to answer without inspecting files, at most one grounding inspection turn is enforced.

No unbounded retry loops or automatic replays of completed host actions.

## State and Observability

`route_plan` logs diagnostic metadata prior to inference:

- logical runtime mode;
- selected transport;
- selected file count;
- context decision reason.

The response payload also includes `x_m365.runtime_mode` and `x_m365.transport`.
