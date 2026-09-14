# 0.8.6 - Atomic Prompt Insertion and Chathub Turn Confirmation

## Overview

Addresses tenant-specific browser behavior where multi-call text insertion could cause rich-text editors to drop earlier chunks.

## Changes

- Native text insertion uses a single atomic `keyboard.insertText()` call for the entire prompt.
- Normalized composer content is verified against full payload prior to dispatch.
- Browser-owned turns include dual start (`LOCAL_PROXY_TURN_*`) and end (`LOCAL_PROXY_END_*`) markers to confirm complete submission.
- Send clicks and Enter keystrokes await explicit Chathub frame receipt with matching markers.
