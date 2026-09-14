> **0.8.0:** `--context-policy adaptive` prevents uploading source code for general questions. The script bridge `--exec-mode script` is documented in [EXPERIMENTAL_EXEC.md](EXPERIMENTAL_EXEC.md).
>
> **0.8.0:** Added named profiles and multi-turn session reuse. See [PROFILES_AND_SESSIONS.md](PROFILES_AND_SESSIONS.md). Automatic writes and backups are detailed in [AUTO_WRITE.md](AUTO_WRITE.md).

# Complete Guide: Menu, Sign-In, Attachments, and Client Setup

## 1. System Components

`m365proxy` is the local proxy server. A dedicated Chromium browser window maintains your Microsoft authentication session. PrAImate, OpenCode, and OpenClaude are clients sending OpenAI-compatible requests to the proxy.

Two transport modes operate deterministically:

```text
Without attachments (direct): CLI -> proxy -> isolated worker -> direct Chathub
With attachments (browser):   CLI -> proxy -> Copilot tab with uploads -> Chathub of THAT tab
```

In browser upload mode, the web interface uploads files and prepares messages. The proxy passively monitors the SignalR WebSocket frames of that exact tab without fabricating credentials.

## 2. Setup via Interactive Menu

Launch the menu:

```bash
m365proxy menu
```

Menu options:

```text
 1 Create new configuration step-by-step
 2 Start a saved configuration
 3 List saved profiles
 4 Edit a configuration
 5 Check proxy status
 6 Run a test probe request
 7 Show connection info / local API key
 8 Preview workspace context files
 9 Open Microsoft sign-in (browser only)
10 View saved change history / backups
11 Undo a change by change ID
12 Delete a profile
 0 Exit
```

`m365proxy guided` opens option 1 directly.

The wizard prompts for port (`1234`), browser channel (`chromium`), context mode (`read`, `hybrid`, `upload`), workspace path, and tool format (`guarded` or `cramt`).

Review the workspace preview, authorize sending context, and save as a named profile (`profiles/<name>.json`).

## 3. Microsoft Authentication

When starting the proxy, the dedicated Chromium window opens. Complete sign-in and MFA in that window.

If the token is not captured immediately on initial page load, send a short message (e.g. `hello`) in Copilot to open Chathub. Wait for `[AUTH] SESSION CAPTURED` in the terminal logs before making client requests.

## 4. Client Integration

Configure your OpenAI-compatible client:

```text
Base URL: http://127.0.0.1:1234/v1
Model:    m365-copilot
API key:  output of `m365proxy key`
```

Get the API key:

```bash
m365proxy key
```

In PrAImate or OpenCode, select the project and point it to the Base URL.

## 5. Verification and Testing

In a separate terminal:

```bash
m365proxy status --port 1234
```

Optionally send a test probe request:

```bash
m365proxy probe --port 1234
```

## 6. How Browser Uploads Work

1. An in-memory snapshot of allowed UTF-8 workspace files is created, honoring `.gitignore`, `.m365ignore`, and security exclusions.
2. Exact byte buffers and collision-free file names are prepared.
3. The first turn claims the initial authenticated Copilot browser tab.
4. The proxy locates the file picker (`input[type=file]` or **Add content / Add and manage sources** -> **Upload images and files**).
5. Playwright passes buffers to the native file input.
6. The proxy awaits upload receipts and attachment cards.
7. Large batches are split into <=3 files per message.
8. The final batch is submitted with the user prompt, correlating SignalR completion records before returning text to the client.

Unchanged files are cached in persistent chats, eliminating duplicate uploads across turns.
