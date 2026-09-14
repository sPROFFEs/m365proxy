# 0.8.3 - Robust Composer Dispatch and Adaptive Action Prioritization

## Changes

- `NativeBrowserUI.send()` executes a structured sequence to locate enabled send controls, simulate input state updates if needed, and confirm submissions through correlated Chathub SignalR frame markers.
- First-token timeout begins when entering `waiting_browser_answer` after verified submission.
- Enhanced detection for local action phrases (`ip a`, `git status`, `hostname -I`) under `exec-mode=script` + `context-policy=adaptive` to avoid unnecessary source attachment uploads.
