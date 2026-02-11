# PAI Unified Terminal

One interactive terminal UX above Claude, Codex, and Gemini.

## What This Is (MVP)

- A Bun-based REPL
- Provider switching (`:provider`)
- Meta-sessions stored in both JSONL and SQLite
- Optional memory integration via claude-mem (context injection + search)
- Hybrid execution: API-first is pluggable, delegated CLI mode is implemented
- Live delegated execution feedback (concise streamed status/tool-call lines)
- Detailed live telemetry for tools/MCP/command execution/file hints

## Delegated Agent Execution Mode

Delegated provider calls are hard-set to YOLO/unsafe mode:

- Claude: `--dangerously-skip-permissions`
- Codex: `--dangerously-bypass-approvals-and-sandbox`
- Gemini: `--yolo`

Gemini reliability defaults to preview-first model fallback:

- order: `gemini-3-flash-preview` -> `gemini-2.5-flash` -> `gemini-2.5-pro` -> `auto`
- override with: `PAI_UT_GEMINI_MODELS=gemini-3-flash-preview,gemini-2.5-flash,gemini-2.5-pro,auto`

## Requirements

- Bun installed
- `claude`, `codex`, and `gemini` CLIs available on PATH (delegated mode)
- Optional: `claude-mem` worker running on `http://127.0.0.1:37777`

## Run

```bash
cd 00-09_System/01_Tools/pai-unified-terminal
bun install
bun run start
```

Launch with an initial prompt (stays interactive):

```bash
bun run start -- "Summarize this repo architecture"
```

One-shot prompt (run once and exit):

```bash
bun run start -- --once --provider codex "Output exactly: OK"
```

One-shot with explicit provider model:

```bash
bun run start -- --once --provider codex --model gpt-5 "Summarize this file"
```

One-shot with explicit context controls from turn one:

```bash
bun run start -- --once --provider claude --mem off --context-mode recent --context-turns 10 "Summarize this file"
```

Global shell launcher (if `unified` is configured in `~/.zshrc`):

```bash
unified "Draft a migration plan"
unified --once --provider claude "Output exactly: PING"
```

## Smoke Test

Fast local-only smoke:

```bash
bun run smoke
```

Optional provider CLI smoke (may call external services):

```bash
PAI_UT_SMOKE_PROVIDERS=1 bun run smoke
```

## Commands

- `:help`
- `:provider claude|codex|gemini|mock`
- `:model <name|auto|default|off>` (`auto/default/off` clears override and uses provider default)
- `:session new [projectName]`
- `:session list`
- `:session resume <metaSessionId>`
- `:context show`
- `:context mode off|recent|full`
- `:context turns <n>`
- `:context chars <n>`
- `:context mem on|off`
- `:mem inject` (shows context that would be injected)
- `:mem search <query>`
- `:mem stats`
- `:mem note <text>`
- `:quit`

## Data Locations

By default, data is stored in:

- JSONL: `~/.pai-unified-terminal/sessions/<metaSessionId>.jsonl`
- SQLite: `~/.pai-unified-terminal/sessions.db`

Override with:

- `PAI_UT_DATA_DIR=/path/to/dir`
- `PAI_UT_DEFAULT_PROVIDER=codex|claude|gemini|mock`
- `PAI_UT_DEFAULT_MODEL=<model-name>`
