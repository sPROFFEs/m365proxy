# 0.3.1 - Transport Lifecycle and Auth Verification

## Fixes and Enhancements

- Immediate inference authentication check (`getTokenNow()`), preventing login/MFA delays inside active inference turns.
- HTTP 428 `authentication_required` returned immediately when browser credentials are missing.
- Configurable total, first-token, and idle timeouts (90s / 45s / 30s).
- Transport isolation in disposable Node.js worker threads.
- Deferred SSE headers ensuring initial upstream failures remain real HTTP JSON error responses.
- Responses API incremental text streaming with `response.failed` terminal events on errors.
- Background credential refresh monitoring before hard token expiration.
