> Note: Since 0.5.0, upload/hybrid modes use BrowserUploadTransport: same tab for upload/send, frame observation, and buffered output. The isolated worker transport continues to handle direct Chathub modes. See UPLOAD_GUIDED.md.

# Architecture

## Components

- `auth.mjs`: Persistent Playwright browser context, Chathub URL observation, in-memory token storage, expiry monitoring, and account change detection.
- `core-loader.mjs`: Loads compiled upstream core modules and Playwright bindings without implementing an alternate Microsoft protocol.
- `worker-session.mjs` & `upstream-worker.mjs`: Runs upstream transport inside isolated disposable worker threads; passes tokens over in-memory IPC, discards stdout/stderr, and terminates on cancellation.
- `lifecycle.mjs`: Abortable execution boundaries even for Promises/iterators that ignore cancellation signals.
- `logging.mjs` & `diagnostics.mjs`: Structured allowlist logging, status queries, and test probe helpers.
- `engine.mjs`: Coordinates `ModelSession({ getToken, useAgent: false })`, session cache, schema parsing, and OpenAI-compatible responses.
- `tool-shim.mjs`: Optional guarded wrapper, upstream prompt formatting, and post-validation. Does not execute tools itself.
- `contracts.mjs` & `schema.mjs`: Strict request validation and JSON Schema subset compliance checking.
- `session-store.mjs`: Exact prefix history matching for Chathub sessions and bounded sticky fallback for browser upload sessions.
- `server.mjs`: Local HTTP listener, Bearer auth validation, size limits, JSON endpoints, and SSE streaming.
- `cli.mjs`: CLI commands, process lock coordination, and clean shutdown hooks.

## Tool Calling Flow

1. The client sends chat history and tool definitions. The proxy validates and rejects malformed schema before contacting Microsoft.
2. Core converts tool definitions into prompt formatting. Guarded mode injects a random per-request delimiter nonce.
3. `ModelSession` transmits the prompt via WebSocket. Authentication tokens come from observed browser sessions, not raw credentials.
4. Output is buffered when tools are present. Formats, function names, and JSON argument schemas are validated before returning `tool_calls`.
5. The client executes the function locally and returns `role=tool` with matching call ID.
6. Exact history continuations reuse the existing session and transmit only prompt deltas. Changing history or definitions rotates to a fresh session.

Every tool call receives a fresh local ID. When `parallel_tool_calls=false`, multiple calls fail closed rather than truncating silently. Errors drop the local session to prevent reusing partial state.

## Streaming and Cancellation

Without tools, text deltas stream as SSE chunks in Chat / Responses APIs. If final text rewrites an already streamed prefix, it fails closed. With tools, output is fully buffered and validated prior to streaming. SSE headers are deferred until initial usable content is available. Errors after stream start terminate with explicit error events rather than fabricating completion.

Client disconnections and first-token/idle/total timeouts abort local processing and terminate worker threads. Partial state is discarded; dead workers are never silently recreated with empty remote history.

## Identity and Transport

Credential capture strictly accepts commercial `substrate.office.com` Chathub endpoints. Only request URLs and WebSocket parameters are observed; passwords and browser headers are never stored. `oid`/`tid` JWT claims are used for local session consistency; Microsoft validates actual TLS signatures.
