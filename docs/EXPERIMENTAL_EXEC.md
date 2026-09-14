# FULL WORKSPACE & Script Execution Bridge

In 0.9.0, FULL WORKSPACE (`--exec-mode script`) uses direct Chathub for all requests and retrieves workspace state on-demand via local script steps. The browser remains active solely for session authentication and for upload-mode profiles.

The execution parser accepts safe schema aliases and performs at most one bounded contract repair turn. Host/project tasks answered without observing actual filesystem state receive a bounded local inspection enforcement turn.

---

# Local Action Script Bridge

This option implements agentic tooling capabilities without relying on native Copilot Web `tool_calls`. It is **disabled by default** and enabled per profile.

## Execution Flow

```text
PrAImate / OpenClaude / OpenCode
             |
             | standard request
             v
         m365proxy
             |
             | private local execution contract
             v
      same Copilot Chathub session
             |
             | ```m365-exec { language, script } ```
             v
         m365proxy
             |
             | writes .m365proxy-tmp/session-.../step-...sh|py|ps1
             | executes with cwd = workspace
             | captures stdout/stderr/exit code
             | deletes temporary script
             v
      same Copilot Chathub session
             |
             | LOCAL EXECUTION RESULT {...}
             v
      final response to CLI client
```

The `m365-exec` block is a contract between the proxy and Copilot. It is not exposed as client-facing `tool_calls`. Intermediate script steps and execution results are processed internally within the proxy; the CLI client receives the final synthesized response.

## Activation

Recommended setup:

```bash
m365proxy guided
```

Choose **1 FULL WORKSPACE [RECOMMENDED]** and select your workspace directory.

Direct command-line setup:

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
  --exec-output-bytes 65536
```

`--exec-mode script` requires an explicit workspace root and cannot be combined with `--context-mode patch` or `--write-mode auto`.

## Task Examples

With execution mode active, prompts can instruct actions naturally:

```text
list the files in /tmp
move reports/old.txt to archive/old.txt
create the output folder and check its disk usage
run git status and summarize the uncommitted changes
read /var/log/my-app.log and show the latest error trace
```

The proxy does not map natural language phrases to commands directly. Copilot receives the execution contract and proposes a temporary script. The proxy executes **that exact script** if it matches allowed languages and formats, feeds the output back into the conversation, and allows Copilot to proceed with subsequent steps or conclude.

## Temporary Session Directory

Upon startup, the proxy prepares an isolated workspace temp directory:

```text
<workspace>/.m365proxy-tmp/session-<pid>-<uuid>/
```

Scripts are created with randomized names and deleted immediately after execution. On clean shutdown, session folders and empty parent temp directories are removed. `.m365proxy-tmp` is protected from context snapshots and file scans.

## Execution Bounds and Permissions

Default bounds:

- Max scripts per request: 4 to 6 (`--exec-max-steps`)
- Timeout per script: 30,000 ms (`--exec-timeout-ms`)
- Max stdout+stderr capture: 65,536 bytes (`--exec-output-bytes`)
- Max script length: 65,536 bytes
- Stdin: closed
- Working directory: workspace root

Supported language interpreters on Linux: `bash`, `sh`, `python` (runs `python3`), `powershell` (runs `pwsh`).

### Security and Privileges

Execution mode does not prompt for per-command user confirmations and is **not a container sandbox**. Scripts run with the permissions of the user running `m365proxy`. The child process environment is sanitized and does not inherit proxy API keys or internal secrets. It receives standard PATH/locale plus:

```text
M365PROXY_WORKSPACE
M365PROXY_TMP
```

## Diagnostics

```bash
m365proxy status --port 1234
```

Responses include an `x_m365.local_exec` object detailing execution steps:

```json
{
  "enabled": true,
  "experimental": true,
  "sandboxed": false,
  "confirmations": false,
  "steps": [
    {
      "step": 1,
      "language": "bash",
      "exit_code": 0,
      "timed_out": false,
      "output_truncated": false,
      "script_retained": false
    }
  ]
}
```

Proxy logs record execution phase progress without exposing script source or command outputs.
