# 0.5.1 - Resilient Copilot Uploader

## Changes

- The file uploader polls for delayed `input[type=file]` elements rather than failing on the initial DOM snapshot.
- Recognizes modern Microsoft UI label **Add and manage sources** alongside **Add content**.
- Locates **Upload images and files** menu options and listens for native `filechooser` events.
- Searches composer and input elements across all page frames.
- `fresh()` uses direct navigation to `https://m365.cloud.microsoft/chat` rather than requiring a dedicated New chat button.
- Diagnostic logs transition through `locating_uploader` before `uploading_files`.
