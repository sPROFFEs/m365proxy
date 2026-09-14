# 0.8.4 - Native Composer Input for Copilot Web

## Changes

- Turns without new attachments reconstruct prompt input via keyboard events to handle rich-text editors that ignore standard `fill()`.
- Multiline prompts format line breaks safely with `Shift+Enter`.
- First-token timeout stays paused while preparing and typing prompt text; countdown starts only after Chathub submission is confirmed.
