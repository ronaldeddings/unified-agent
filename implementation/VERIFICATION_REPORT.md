# Verification Report - unified-agent Brain + Multi-Provider

Date: 2026-02-11

## Automated Verification

- `bun test`: PASS (`65` pass, `0` fail)
- `bun run smoke`: PASS
- `bun run smoke:gateway`: PASS
- `bun run smoke:adapter:claude`: PASS
- `bun run smoke:adapter:codex`: PASS
- `bun run smoke:adapter:gemini`: PASS
- `bun run verify:e2e`: PASS (delegated + brain-mode paths across Claude/Codex/Gemini)

## Real End-User Style Runs (Actual App)

All commands executed via `bun run start -- --once ...`.

### Delegated Mode

1. Claude
   - Command: `--provider claude "Output exactly: UA_CLAUDE_OK"`
   - Result: PASS (`UA_CLAUDE_OK`)

2. Codex
   - Command: `--provider codex "Output exactly: UA_CODEX_OK"`
   - Result: PASS (`UA_CODEX_OK`)

3. Gemini
   - Command: `--provider gemini "Output exactly: UA_GEMINI_OK"`
   - Result: PASS (output contains `UA_GEMINI_OK`; provider emits additional wrapper text in this environment)

### Brain Mode (`--brain-url`)

Gateway server started via `bun run gateway:serve` at `ws://127.0.0.1:7799`.

1. Codex
   - Command: `UNIFIED_AGENT_ALLOW_INSECURE_BRAIN=1 --brain-url ws://127.0.0.1:7799/ws?sessionId=brain_codex --brain-provider codex`
   - Result: PASS (`BRAIN_CODEX_OK`)

2. Gemini
   - Command: `UNIFIED_AGENT_ALLOW_INSECURE_BRAIN=1 --brain-url ws://127.0.0.1:7799/ws?sessionId=brain_gemini --brain-provider gemini`
   - Result: PASS (output contains `BRAIN_GEMINI_OK`; provider emits additional wrapper text in this environment)

3. Claude
   - Command: `UNIFIED_AGENT_ALLOW_INSECURE_BRAIN=1 --brain-url ws://127.0.0.1:7799/ws?sessionId=brain_claude --brain-provider claude`
   - Result: PASS (`BRAIN_CLAUDE_OK`) via native sdk-url relay path (no fallback required).

## Completion Status for Requested Additions

1. Persistent queue + pending-permission rehydration across restart: COMPLETE.
2. Deeper Codex/Gemini control subtype parity: COMPLETE (emulated compatibility for `mcp_*`, `rewind_files`, `hook_callback`).
3. Metrics export path: COMPLETE (`/metrics` Prometheus + optional OTLP push exporter).
4. Claude native sdk-url parity for one-shot relay: COMPLETE (stdin control frames + websocket relay/result capture).
