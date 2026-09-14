> **0.8.0:** Default context policy is `adaptive`: general questions can use 0 attachments. Experimental script bridge `--exec-mode script` is documented in [EXPERIMENTAL_EXEC.md](EXPERIMENTAL_EXEC.md) and disabled by default.

# Named Profiles and Session Management

## 1. Named Profiles

Configurations do not overwrite each other. `m365proxy menu` and `m365proxy guided` store each profile under an independent name in the private state directory:

```text
~/.m365-copilot-local/profiles/
  project-a.json
  webapp.json
  lab.json
```

Each file contains validated CLI arguments only: port, workspace, context mode, browser channel, execution limits, write mode, and conversation policy. Passwords, cookies, Microsoft tokens, and API keys are never stored in profile JSON files.

Create or manage profiles via CLI:

```bash
m365proxy guided
m365proxy profile list
m365proxy profile show project-a
m365proxy profile run project-a
m365proxy profile clone project-a project-a-dev
m365proxy profile delete project-a-dev
```

### State Directory and Concurrency

Profiles allow toggling between environments, not bypassing the browser lock. All default profiles share:

```text
~/.m365-copilot-local/browser-profile
~/.m365-copilot-local/api-key
~/.m365-copilot-local/process.lock / process.guard
```

Only one proxy instance can actively serve against a given `state-dir` at a time. To run concurrent instances, supply distinct `--state-dir` and `--port` parameters.

## 2. Multi-Turn Session Reuse

`--conversation-mode reuse` is the default policy. The proxy maintains an in-memory `SessionStore`. For direct Chathub sessions, exact matching is required. For browser upload modes, the proxy attempts exact prefix matching first, falling back to a bounded sticky session per workspace/model scope.

If explicit client thread isolation is required, supply the `X-Session-Id` header or configure `--conversation-mode fresh`.

### Direct Chathub / cramt

Reuses the active `ModelSession` instance and transmits only prompt deltas to the remote backend.

### Browser Upload Mode

The first `BrowserUploadSession` claims the initial authenticated Copilot tab. If Chathub was already connected, socket handles are retained so turn observers attach without page reloads.

The proxy caches SHA-256 hashes of uploaded attachments for that tab:

- Unchanged files are cached and not re-uploaded.
- Modified files are attached anew in the persistent chat.
- The authoritative workspace manifest informs the model which file versions are current.

## 3. Conversation Rotation Policy

Sessions rotate or reset when:

- `--conversation-mode fresh` is configured;
- The reusable browser tab is closed or lost;
- The browser authentication session changes or disconnects;
- The conversation exceeds TTL (`--conversation-ttl-ms 3600000`);
- Turn count reaches maximum (`--conversation-max-turns 32`);
- Cache exceeds capacity (`--conversation-max 8`) and evicts the least recently used session;
- An unrecoverable upstream error occurs;
- The proxy process restarts.

## 4. Diagnostics and Health

With the proxy running:

```bash
m365proxy status --port 1234
```

`/health` exposes session telemetry:

```text
conversations_in_memory
cramt_conversations_in_memory
browser_conversations_in_memory
conversation_policy.mode
conversation_policy.ttl_ms
conversation_policy.max_turns
conversation_policy.max_sessions
```

Responses include `x_m365.session_reused` indicating whether the turn reused remote context.

## 5. Attachment Batching (3 Files Per Message)

Microsoft Copilot Web limits messages to a maximum of 3 attachments. The proxy automatically splits larger batches into internal context synchronization turns within the same chat, sending the real user prompt alongside the final batch.
