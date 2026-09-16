# m365proxy — OpenAI-Compatible Proxy for Microsoft 365 Copilot

**Use Microsoft 365 Copilot Web through a local OpenAI-compatible API.**

`m365proxy` exposes Microsoft 365 Copilot (M365 Copilot) as a local endpoint for OpenAI-compatible clients, scripts, coding tools, and agent workflows. It uses browser authentication, supports named profiles and deterministic routing, and can optionally give Copilot controlled access to a local workspace.

> [!IMPORTANT]
> `m365proxy` is an independent open-source project and is not affiliated with or endorsed by Microsoft. It integrates with Microsoft 365 Copilot Web behavior; it is not an official Microsoft 365 Copilot API.

## Why m365proxy?

Use `m365proxy` when you want a local Microsoft 365 Copilot API bridge without changing an OpenAI-compatible client.

* **OpenAI-compatible local endpoint** — connect clients to `http://127.0.0.1:1234/v1`.
* **Microsoft 365 Copilot Web backend** — use Copilot through an authenticated browser session.
* **Browser authentication** — capture and reuse the signed-in Copilot Web session.
* **Named profiles** — keep separate configurations for different projects and workspaces.
* **Deterministic routing** — each profile follows a defined transport path instead of switching behavior based on prompt keywords.
* **Workspace-aware modes** — choose chat only, read-only workspace context, or full workspace access.
* **Local agent-style execution** — FULL WORKSPACE can inspect files, modify the workspace, and execute bounded local scripts.
* **Diagnostics built in** — inspect status, probe the proxy, run health checks, and verify the selected route.
* **Advanced upload/hybrid modes** — available when you explicitly need browser-upload behavior.

## Project status

Current version: **0.9.0**

Version 0.9.0 focuses on predictable behavior and stable routing. EXEC requests use direct Chathub instead of automatically falling back to the browser composer or upload flow.

## Requirements

* **Node.js 24 or newer**
* Access to **Microsoft 365 Copilot Web**
* A browser session that can authenticate to Microsoft 365 Copilot
* Linux for the currently documented packaged installer flow

The runtime executes under the privileges of the user that starts `m365proxy`.

## Quick start

### Packaged Linux install

The current packaged installation flow is:

```bash
unzip m365-copilot-local-linux-v0.9.0.zip
cd m365-copilot-local
bash install.sh
export PATH="$HOME/.local/bin:$PATH"
m365proxy menu
```

Run `install.sh` as your normal desktop user, **not** with `sudo`. The installer only uses `sudo` when system package dependencies are missing.

### Source / development commands

From the repository root, the project exposes these npm commands:

```bash
npm run setup
npm run guided
npm run serve
```

You can also use the CLI-oriented scripts documented later in this README.

## First configuration

The easiest setup path is the guided configuration:

```bash
m365proxy guided
```

For the full local workspace experience, select:

```text
FULL WORKSPACE
```

Choose the workspace directory, save the profile, and start the proxy.

Equivalent command-line configuration:

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

## Operating modes

| Mode                    | Workspace access   | Local execution | Transport                       | Best suited for                                                          |
| ----------------------- | ------------------ | --------------- | ------------------------------- | ------------------------------------------------------------------------ |
| **FULL WORKSPACE**      | Read + modify      | Yes             | Direct Chathub                  | Agent-style project work where Copilot must inspect or change real files |
| **WORKSPACE READ-ONLY** | Read/context only  | No              | Direct Chathub                  | Codebase or document context without local writes or command execution   |
| **CHAT ONLY**           | None               | No              | Direct Chathub                  | A simple local Microsoft 365 Copilot chat proxy                          |
| **ADVANCED / LEGACY**   | Depends on profile | Optional        | Explicit upload/hybrid behavior | Compatibility and experimental browser-upload workflows                  |

The important design rule is simple:

**A profile follows a deterministic route.**

EXEC does not silently switch to the browser composer. Browser upload remains isolated to non-EXEC profiles that explicitly enable it.

## Connect an OpenAI-compatible client

Use these values in a client that supports a custom OpenAI-compatible API endpoint:

```text
Base URL: http://127.0.0.1:1234/v1
Model:    m365-copilot
API key:  output of `m365proxy key`
```

Get the local API key with:

```bash
m365proxy key
```

Start the proxy, complete browser authentication, and wait until the logs show:

```text
[AUTH] SESSION CAPTURED
```

Then connect your client.

## Named profiles

Profiles let you keep separate settings for different projects, workspace permissions, ports, and execution modes.

```bash
m365proxy profile list
m365proxy profile show NAME
m365proxy profile run NAME
m365proxy profile clone SOURCE NEW_NAME
m365proxy profile delete NAME
```

A practical pattern is to keep separate profiles for:

* chat-only usage;
* read-only repository analysis;
* full workspace development;
* advanced upload or hybrid workflows.

## How FULL WORKSPACE works

FULL WORKSPACE does **not** upload an entire repository before every request.

Instead, the model receives a local capability that can inspect or act on the workspace when the task requires real file state. The proxy uses an explicit textual script contract, local execution, and feedback turns inside the same Chathub conversation.

When a request depends on the actual project or host state, `m365proxy` can enforce a bounded local inspection/action turn before accepting a final answer.

This is agent-style tool emulation. It is **not** native Microsoft 365 Copilot function calling.

## Security model

> [!WARNING]
> FULL WORKSPACE can execute local scripts with the same operating-system privileges as the user running `m365proxy`. The execution environment is not a sandbox.

Execution mode does not ask for confirmation before every command. The proxy limits execution with controls such as:

* maximum execution steps;
* execution timeout;
* request timeout;
* output-size bounds;
* guarded tool behavior.

Use FULL WORKSPACE only for directories and projects you are comfortable allowing the local process to inspect and modify.

If you do not need local execution, use **WORKSPACE READ-ONLY** or **CHAT ONLY**.

## Diagnostics

Check the running service:

```bash
m365proxy status --port 1234
m365proxy probe --port 1234
m365proxy doctor
```

Every request logs a `route_plan`, for example:

```text
route_plan mode=full_workspace transport=direct_chathub context_decision=exec_capability
```

The route plan makes it possible to verify that a request did not silently change transport or backend behavior.

## Advanced upload and hybrid modes

Upload and hybrid modes remain available under the advanced configuration.

These modes are intentionally separated from EXEC profiles because browser-driven upload behavior is more sensitive to Microsoft 365 Copilot Web UI changes.

Microsoft 365 Copilot Web currently allows a maximum of three attachments per message. When a larger file selection is used, the proxy can split it across multiple turns in the same conversation.

## Limitations

`m365proxy` is designed around Microsoft 365 Copilot Web behavior, so there are important limitations:

* Microsoft 365 Copilot Web does not expose a public native function-calling API for this workflow.
* FULL WORKSPACE implements local agent behavior through script-contract execution and feedback loops.
* Local execution runs with the privileges of the user that launched the proxy.
* Advanced browser-upload behavior may require maintenance when the Copilot Web UI changes.
* Attachment behavior is constrained by Copilot Web limits.
* OpenAI compatibility does not mean that every feature of every OpenAI-compatible client is automatically supported.

## What changed in 0.9.0

Version 0.9.0 prioritizes stability over prompt-driven heuristics:

* EXEC always uses `direct_chathub`.
* EXEC no longer automatically falls back to `browser_with_attachments`.
* FULL WORKSPACE inspects the filesystem on demand instead of scanning and uploading the whole workspace before each request.
* Malformed `m365-exec` blocks receive one bounded repair turn before failing cleanly.
* Safe execution aliases such as `command`, `code`, and `shell` are accepted without widening executable content.
* Tasks that depend on real project or host state can trigger a bounded local-inspection enforcement turn.
* Browser upload for non-EXEC profiles uses the stable upload path.
* The interactive menu prioritizes the three recommended modes and moves upload/hybrid and auto-write behavior under Advanced.

## npm scripts

The repository currently exposes the following project commands:

| Command                   | Purpose                                        |
| ------------------------- | ---------------------------------------------- |
| `npm run setup`           | Bootstrap the project                          |
| `npm run serve`           | Start the proxy                                |
| `npm run login`           | Start the login flow                           |
| `npm run guided`          | Guided configuration                           |
| `npm run menu`            | Interactive menu                               |
| `npm run key`             | Show or manage the local API key               |
| `npm run status`          | Check proxy status                             |
| `npm run probe`           | Probe the running proxy                        |
| `npm run doctor`          | Run diagnostics                                |
| `npm test`                | Run the Node test suite                        |
| `npm run verify:upstream` | Verify upstream state                          |
| `npm run check:browser`   | Check browser setup                            |
| `npm run demo:tools`      | Run the tool-loop example                      |
| `npm run pack`            | Build a package                                |
| `npm run pack:full`       | Build a package with required upstream content |

## Documentation

More implementation details are available in:

* [Architecture](docs/ARCHITECTURE_0.9.0.md)
* [0.9.0 changelog](docs/CHANGELOG_0.9.0.md)
* [Experimental execution](docs/EXPERIMENTAL_EXEC.md)
* [Test report](TEST_REPORT.md)
* [Third-party notices](THIRD_PARTY_NOTICES.md)

## Troubleshooting

### The client cannot connect

Check the proxy and port:

```bash
m365proxy status --port 1234
m365proxy probe --port 1234
```

Then run:

```bash
m365proxy doctor
```

### Authentication is not ready

Do not send client requests until the proxy logs:

```text
[AUTH] SESSION CAPTURED
```

### A workspace answer does not reflect real files

Confirm that the profile is running in the intended workspace mode and inspect the request's `route_plan`.

For tasks that require real project state, use FULL WORKSPACE or an appropriate read-only workspace profile instead of CHAT ONLY.

### Browser upload is unstable

Prefer direct Chathub modes unless you specifically need advanced upload/hybrid behavior. Browser-upload flows are more exposed to Copilot Web UI changes.

## Contributing

Issues, bug reports, documentation improvements, and pull requests are welcome.

When reporting a problem, include:

* `m365proxy` version;
* operating system;
* Node.js version;
* active profile mode;
* relevant `route_plan`;
* output from `m365proxy doctor`;
* minimal reproduction steps.

Do not include authentication secrets, session data, API keys, or private workspace content.

## License

Released under the [MIT License](LICENSE).

---

**m365proxy** is a local OpenAI-compatible Microsoft 365 Copilot proxy for developers who want browser-authenticated M365 Copilot access from existing API clients, local tools, and workspace-aware workflows.
