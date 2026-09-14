> **0.8.0:** Default context policy is `adaptive`: general questions can use 0 attachments. Experimental script bridge `--exec-mode script` is documented in [EXPERIMENTAL_EXEC.md](EXPERIMENTAL_EXEC.md) and disabled by default.
>
> **0.8.0:** Named profiles and safe conversation reuse are available. See [PROFILES_AND_SESSIONS.md](PROFILES_AND_SESSIONS.md).

# OpenCode & Compatible Clients

## Recommended Setup: OpenAI-Compatible

Start the proxy:

```bash
m365proxy --port 1234 --tool-mode cramt
```

In your terminal before launching OpenCode:

```bash
export M365PROXY_API_KEY="$(m365proxy key)"
```

Configure your client to use provider `m365`, model `m365-copilot`, and Base URL `http://127.0.0.1:1234/v1`. Do not set `/chat/completions` as the Base URL. Anthropic `/v1/messages` is not supported.

- OpenCode v1 configuration format (`provider/npm/options`): `examples/opencode-v1.jsonc`.
- OpenCode v2 configuration format (`providers/package/settings`): `examples/opencode-v2.jsonc`.

Select `m365/m365-copilot` in your client model selector and start a fresh chat.

## Native Ollama Compatibility

When a client sends `POST /api/chat`, the proxy responds with NDJSON and a final `done: true` chunk. It uses the same port and Bearer API key authentication.

- If an SDK appends `/chat`, set the Base URL to `http://127.0.0.1:1234/api`.
- If an SDK appends `/api/chat`, set the Base URL to `http://127.0.0.1:1234`.

This is not a standalone Ollama engine: local weights, `/api/generate`, embeddings, model pulling, and vision are not implemented.

## Diagnostics

```bash
m365proxy status --port 1234
m365proxy probe --port 1234
```

The proxy logs HTTP requests with structured route names:

```text
[REQ] http_request ... route=chat_completions method=POST path=/v1/chat/completions
[REQ] http_request ... route=ollama_chat method=POST path=/api/chat
[REQ] http_request ... route=unknown method=POST path=/v1/messages
```

Unrecognized routes that might contain query parameters or sensitive IDs are sanitized. Prompts and tokens are never printed to console logs.
