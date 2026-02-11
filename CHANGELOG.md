# Changelog

## 0.2.0 - 2026-02-11

- Added remote brain flags: `--brain-url`, `--brain-provider`, `--brain-session-id`.
- Added REPL brain commands: `:brain connect`, `:brain disconnect`, `:brain status`, `:brain replay`.
- Added session schema fields: `brainUrl`, `brainProvider`, `gatewaySessionId`, `providerSessionId`.
- Added canonical control/transport event types and payload persistence.
- Added SQLite migrations for remote metadata and event payload column.
- Added adapter layer:
  - `ClaudeNativeAdapter` with `--sdk-url` pass-through.
  - `CodexCompatAdapter` compatibility mode.
  - `GeminiCompatAdapter` compatibility mode.
  - `MockCompatAdapter` test adapter.
- Added gateway package:
  - protocol validation
  - error model
  - policy checks
  - compatibility fallbacks
  - queueing and pending permissions
  - replay buffer and hydration helpers
  - session registry
  - router
  - websocket server + heartbeat + relaunch watchdog
  - replay runner
- Added smoke scripts:
  - gateway smoke
  - adapter smokes for Claude/Codex/Gemini
  - remote metadata migration script
- Expanded tests for CLI parsing, protocol/policy, router lifecycle, queues, replay, normalizers, and migrations.
