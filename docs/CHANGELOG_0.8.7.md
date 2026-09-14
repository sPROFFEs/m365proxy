# 0.8.7 - Direct Chathub Transport for Zero-Attachment EXEC

## Overview

In `exec-mode=script` with adaptive context selecting zero files, the proxy bypasses the browser composer entirely and uses direct Chathub.

## Changes

- `EXEC + hybrid/upload + selected_files=0` uses direct cramt/Chathub transport.
- Playwright/Copilot Web is reserved for turns that require native attachments.
- The `m365-exec -> local execution -> result -> Copilot` loop executes inside the same direct Chathub session without touching the browser DOM.
- Direct EXEC prompts strip large client-side system boilerplate, retaining user requests and local proxy contracts.
- Diagnostic log `exec_transport_selected` records `direct_chathub` or `browser_with_attachments`.
- `x_m365.exec_transport` reports the effective transport used.
