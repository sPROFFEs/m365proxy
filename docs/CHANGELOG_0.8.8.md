# 0.8.8 - EXEC Direct Transport for Local File Actions

## Problem Fixed

In an `exec-mode=script` + `context-policy=adaptive` profile, prompts like `create a bash hello world script` triggered source file selection due to keyword matching, switching transport from `direct_chathub` to `browser_with_attachments` and risking composer desynchronization.

## Changes

- Creating files, scripts, or directories is classified as a local action in EXEC mode when existing sources are not referenced.
- These operations use zero uploads under `adaptive` policy.
- Direct EXEC turns use a dedicated `SessionStore` with sticky reuse to maintain conversation continuity when coding CLIs rewrite system prompts between turns.
- EXEC sticky reuse is isolated from normal chat and browser stores.
- `/health` separates normal cramt and EXEC session metrics.
