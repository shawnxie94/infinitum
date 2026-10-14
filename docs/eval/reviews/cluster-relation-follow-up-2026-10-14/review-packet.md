# 新来源定向人工审核包

每对选择 same_event / synthesis / follow_up / unrelated / uncertain，并给出一句原文依据。只比较这两次发布记录；发布时间可定位发布，不替代其中提到的其他事件日期。

候选是定向选取，不是随机抽样；没有模型预测或预填标签。下方为官方原文摘录，完整原文和发布元数据在 sources.json 与来源链接中保留。

## FN-01

### 左：anthropics/claude-code v2.1.295

发布记录时间（UTC）：2026-10-08T19:48:38Z

官方来源：https://github.com/anthropics/claude-code/releases/tag/v2.1.295

- Added support for `forceLoginMethod: "gateway"` and `forceLoginGatewayUrl` in your own user settings on machines with no managed settings, so `/login` opens on that Claude apps gateway

### 右：anthropics/claude-code v2.1.296

发布记录时间（UTC）：2026-10-09T19:28:59Z

官方来源：https://github.com/anthropics/claude-code/releases/tag/v2.1.296

- Fixed a saved Claude apps gateway sign-in being ignored on machines whose managed settings set `forceLoginMethod` to `gateway` with no `forceLoginGatewayUrl` (regression in 2.1.295)


## FN-02

### 左：openai/codex rust-v0.162.0

发布记录时间（UTC）：2026-10-08T18:55:59Z

官方来源：https://github.com/openai/codex/releases/tag/rust-v0.162.0

## New Features

- Add tools for creating and listing managed Git worktrees from trusted local projects when the worktrees feature is enabled. (#50148)
- Pin tasks in the agent Command Center with `p` and keep them in a shared Pinned group when supported by the server. (#51500)
- Navigate and copy transcript blocks with `/copy`, use `Ctrl+Insert` to copy selections, and tune mouse-wheel scrolling with `tui.mouse_scroll_speed`. (#50434, #50215, #50209)
- Make URLs clickable in approval headers, questions, MCP prompts, warnings, banners, and verification prompts, including when links wrap across lines. (#51439, #51449, #51450, #51451, #51452, #51458)
- Configure live web access and remote compaction capabilities for custom Responses-compatible model providers. (#50459)
- Add JavaScript helpers for streaming promise results as they settle, plus opt-in ranked tool search in Code Mode. (#51126, #51209)

## Bug Fixes

- Respect server model and reasoning-summary defaults for new TUI threads while retaining explicit launch overrides. (#50013, #50811, #50913)
- Preserve existing CRLF line endings in `apply_patch` updates without requiring an opt-in. (#51203)
- Fix Linux sandbox startup with multiple denied files, reject writable sandbox-construction executables, and keep ripgrep configuration from weakening deny-glob masks. (#50059, #51211, #51407, #51527)
- Restore ordinary drive-letter file access on Windows 10 and match Windows sandbox temp permissions to the child process environment. (#51511, #51512)
- Honor server `Retry-After` advice for retryable Responses and WebSocket failures. (#50418, #51440)
- Fix archive checksum verification when installing through Windows PowerShell with PowerShell 7 module paths present. (#51257)

## Chores

- Publish a signed PowerShell installer with Windows releases. (#51158)
- Keep older stable releases and prereleases from replacing newer stable download targets or installer aliases. (#51186, #51425)

### 右：openai/codex rust-v0.162.1

发布记录时间（UTC）：2026-10-09T19:44:51Z

官方来源：https://github.com/openai/codex/releases/tag/rust-v0.162.1

## Bug Fixes

- Fixed a TUI crash when asynchronous questions contain multiple lines, preserving line breaks and complete hyperlink destinations. (#51866)
- Fixed startup failures caused by differences between a running background server's feature settings and CLI defaults. Compatibility checks now apply only to explicit command-line feature overrides. (#52648)

Full Changelog: https://github.com/openai/codex/compare/rust-v0.162.0...rust-v0.162.1
