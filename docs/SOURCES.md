# Sources and Upstream References

Primary upstream repository reference:

- Upstream Repository: https://github.com/cramt/m365-copilot-proxy
- Pinned Upstream Revision: `d7c6d8080bf2bb769c1949c2dfbe60bb7ca929c3` (tracked in `UPSTREAM.json`)
- Upstream License: MIT License (preserved in `vendor/cramt` upon installation)

## Technical References

- Node.js AbortController & AbortSignal: https://nodejs.org/api/globals.html#class-abortcontroller
- Node.js Worker Threads & Lifecycle: https://nodejs.org/api/worker_threads.html
- Playwright Persistent Context & Network Events: https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context
- OpenAI Responses API Streaming Events: https://developers.openai.com/api/reference/resources/responses/streaming-events
- Gitignore Specification: https://git-scm.com/docs/gitignore

The custom `.m365ignore` parser is an independent, bounded implementation designed for local proxy workspace security and is not a direct derivative of git core.
