# 0.8.5 - Fast Composer and Compact EXEC Prompts

## Changes

- Prioritizes fast `page.keyboard.insertText()` in blocks instead of character-by-character `pressSequentially()`.
- Strips large client-side `system` and `developer` boilerplate before sending EXEC browser turns to avoid polluting rich-text editors.
- Retains conversational messages, user prompts, workspace policies, and execution contracts.
- Logs `browser_prompt_ready` with byte size and count of omitted client instructions without logging prompt contents.
