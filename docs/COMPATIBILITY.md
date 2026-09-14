> **0.8.0:** Default context policy is `adaptive`: general questions can use 0 attachments. Experimental script bridge `--exec-mode script` is documented in [EXPERIMENTAL_EXEC.md](EXPERIMENTAL_EXEC.md) and disabled by default.
>
> **0.8.0:** Named profiles and safe conversation reuse are available. See [PROFILES_AND_SESSIONS.md](PROFILES_AND_SESSIONS.md).
>
> **0.5.1:** Added interactive menu and upload/hybrid modes; in these modes `model` does not choose a web model, output is buffered, and Microsoft web UI controls are experimental. See UPLOAD_GUIDED.md.

# Client Compatibility

## HTTP Endpoints

| Route | Description / Contract |
|---|---|
| `GET /health` | Local proxy health and auth status; requires API key. `ready` does not prove successful upstream inference. |
| `GET /v1/models` | Available model routes published by core plus configured local aliases. `GET /models` is an alias. |
| `POST /v1/chat/completions` | OpenAI-compatible Chat Completions, JSON or SSE. `/chat/completions` is an alias. |
| `POST /v1/responses` | Partial OpenAI Responses API adapter, JSON or SSE. `/responses` is an alias. |

The default mode is **permissive compatibility**. Common parameters that Microsoft Copilot web does not support (`reasoning_effort`, `reasoning`, `temperature`, `max_tokens`, `max_completion_tokens`, `verbosity`, `store`, `metadata`, etc.) are accepted and ignored. Ignored parameters are recorded in `x_m365.ignored_parameters`. The proxy never fabricates that Microsoft applied unsupported parameters.

For strict validation during debugging, start with `m365proxy --strict` or `M365PROXY_STRICT=1`; in strict mode, unsupported parameters return HTTP 400. `--compat` forces permissive mode.

Unknown model IDs sent by clients are treated as aliases in compatibility mode and routed to `m365-copilot` (or the default core route). The response echoes the requested name, and `x_m365.upstream_model_route` displays the actual upstream route used.

## Chat Completions

- Supported roles: `system`, `developer` (normalized to system), `user`, `assistant`, `tool`.
- Content: UTF-8 strings or text parts. Images, audio, and binary attachments are not supported via the standard chat completions endpoint.
- Tool messages must match prior `tool_calls` with unique IDs.
- `tools`, `tool_choice`, `parallel_tool_calls`, streaming, and `n=1` are supported. Legacy `functions`/`function_call` parameters are translated in compatibility mode.

## Responses API

The adapter accepts text `input` or message items, `instructions`, function tools, `tool_choice`, `parallel_tool_calls`, and `stream`. `function_call` and `function_call_output` items are mapped to internal Chat Completions structures.

Output translates to a `response` object containing `message` / `function_call` items. Without tools, text deltas stream as output item events. With tools, output is buffered until validated. Stream errors emit `response.failed`, never `response.completed`.

## Tool Calling

- Only `type=function` is supported.
- Functions require unique names, optional descriptions, and JSON Schema object parameters.
- Tool calling is **emulated via prompt engineering and response parsing**, not native backend Copilot function calling. The proxy does not execute client tools; it returns parsed proposals to the client.
- `guarded` (default) injects an exact random nonce wrapper around tool proposals before validating name and JSON arguments against schema. `cramt` mode uses upstream core parsing with local post-validation.

## JSON Schema Subset

Supported schema keywords: `type`, `properties`, `required`, `additionalProperties`, `items`, `prefixItems`, numeric/string/array bounds, `enum`, `const`, `anyOf`, `oneOf`, `allOf`, `not`, local `$ref`, `$defs`, and `definitions`. External URI references, regex `pattern`, `patternProperties`, and `format` are not evaluated.

## HTTP Status Codes

- **400 Bad Request:** Malformed JSON, invalid schema, or unsupported parameters in strict mode.
- **401 Unauthorized:** Missing or invalid local Bearer API key.
- **403 Forbidden:** Disallowed Host header or browser cross-origin requests.
- **428 Precondition Required:** Microsoft browser session not ready, expired, closed, or account changed. Requires user sign-in action in browser.
- **429 Too Many Requests:** Proxy busy with active request, request queue full, or upstream Copilot rate limit detected.
- **502 Bad Gateway:** Upstream transport error, empty response, refusal, or invalid tool/edit contract.
- **503 Service Unavailable:** No model routes available, worker failure, or missing upstream package.
- **504 Gateway Timeout:** First-token, idle, script execution, or total request deadline expired.

## Ollama and OpenCode Compatibility

See [docs/OPENCODE.md](OPENCODE.md). `POST /api/chat` uses NDJSON streaming, never SSE. Only text and emulated tools are supported. `/api/tags`, `/api/show`, and `/api/version` expose synthetic proxy metadata. Bearer authentication is mandatory.
