# 0.7.1 - Primary Tab Reuse and 3-Attachment Batches

## Browser Conversations

- `upload` and `hybrid` modes claim the initial Copilot tab opened during sign-in instead of launching redundant tabs.
- Retains WebSocket handles to attach observers without page reloads.
- Bounded sticky fallback maintains conversation continuity when clients rewrite system preambles.
- Preventive background token refresh uses a temporary page to avoid reloading active conversation tabs.

## 3-File Attachment Batch Limit

- Copilot Web limits messages to 3 attachments.
- Batches larger than 3 files are split across internal context-sync turns in the same chat before submitting the prompt with the final batch.
