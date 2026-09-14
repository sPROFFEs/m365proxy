# Security Policy and Operational Boundaries

## Secret Management

- The local API key is generated with cryptographic randomness and compared using timing-safe comparison (`safeEqual`).
- Local state resides outside the project root: private directory (`0700`) and key file (`0600`) on POSIX systems.
- Captured access tokens exist in memory only. **Persistent browser profiles store session cookies and authentication state** and must be treated as sensitive credentials.
- Error messages returned to clients are sanitized to prevent disclosing internal paths, upstream URLs, or credentials.

## Endpoint & Network Isolation

- Fixed loopback binding on `127.0.0.1`.
- All endpoints mandate a valid local Bearer API key.
- Strict `Host` validation and refusal of browser cross-origin requests (`Sec-Fetch-Site` / `Origin`) to prevent DNS rebinding and cross-site scripting from local browser tabs.
- Do not expose the proxy port to public networks or external reverse proxies without additional authentication layers.

## Microsoft Infrastructure & Data Flow

- Prompts and tool results are transmitted to Microsoft 365 Copilot infrastructure.
- The proxy does not attempt to bypass Microsoft Conditional Access, Device Compliance, tenant DLP policies, or content safety filters.
- Account changes detected during execution immediately abort in-flight requests and invalidate cached sessions.

## Worker Process Isolation

- Upstream WebSocket and transport logic runs inside isolated Node.js worker threads (`WorkerModelSession`).
- Worker threads isolate Node.js event loops from upstream hangs or unhandled exceptions.
- The worker boundary is an operational stability isolation mechanism, not a security sandbox against malicious local dependencies.

## Process Locks & Concurrency

- Process exclusion uses kernel `flock` and PID metadata tracking boot ID, start ticks, and process namespace.
- Clean shutdown on `SIGINT`, `SIGTERM`, and `SIGHUP`. Stale locks left by `SIGKILL` are safely verified and recovered on subsequent launches.

## Workspace Security and File Policies

- Workspace filesystem access is strictly opt-in via `--workspace` / `--workspaces`.
- Workspace readers prevent path traversal, reject symlinks/hardlinks pointing outside the project, and anchor reads to secure file descriptors.
- Secret filtering and `.m365ignore` rules provide defense-in-depth against accidental context inclusion.

## Browser Uploads & Storage

- In upload/hybrid modes, files are uploaded to Microsoft storage via the browser session and may remain in tenant OneDrive storage.
- The proxy never creates or deletes remote cloud files outside of Copilot's standard upload interface.
- Profile configurations (`profiles/<name>.json`, `0600`) contain validated CLI flags only; credentials, tokens, and API keys are never persisted inside profile files.
