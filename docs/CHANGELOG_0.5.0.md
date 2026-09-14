# 0.5.0 - native browser attachments and guided startup

- Adds upload/hybrid to workspace modes; prompt aliases read.
- Independent upload budgets, exact scanned buffers, collision-free native file names.
- Same-tab upload and prompt; fresh conversation per request, no unsupported file-ID
  injection into another cramt conversation. Worker/cramt path unchanged for other modes.
- Passive bounded SignalR observer correlates the owned invocation and final answer;
  cumulative frames are buffered and completion is protocol-based, not a DOM idle timer.
- Upload receipt/card checks, extension accept checks, explicit errors and finite deadlines.
  No prompt fallback, no retry, no remote deletion. Partial cloud copies may remain.
- New configurable UI selectors; no arbitrary URL, eval or HTTP root registration.
- Model labels stay API-compatible; browser upload uses the web conversation default.
- menu/guided in Spanish, local preview, consent, optional private saved profile, status,
  probe and connection/key helpers. No shell eval, saved credentials or auto daemon.
- Optional m365prox alias from installer; conflicts are left unchanged.
- Lock/signal recovery, Chat/Responses/Ollama, read context and patch review preserved.

Non-goals: cross-turn attachment cache, cloud cleanup, real-time token streaming for
browser-owned turns, arbitrary documents/images, local command/file execution, automatic
PrAImate cwd discovery, guaranteed tenant/UI compatibility or native function calling.

See TEST_REPORT.md for the actually executed checks and integration limitations.
