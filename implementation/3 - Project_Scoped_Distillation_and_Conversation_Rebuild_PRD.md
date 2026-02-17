# PRD #3 — Project-Scoped Distillation & Conversation Rebuild

> **Goal:** One command produces a perfect pre-built conversation JSONL from the N most recent sessions for a given project directory, assessed by multiple AI providers, formatted so `claude --resume <session-id>` gives Claude complete project context where every request succeeds on the first try.

**Status:** Not Started
**Depends on:** PRD #2 (Phase 1-9 complete)
**Date:** 2026-02-16

---

## Table of Contents

1. [Desired End State](#1-desired-end-state)
2. [Current State Analysis](#2-current-state-analysis)
3. [Gap Analysis](#3-gap-analysis)
4. [Implementation Phases](#4-implementation-phases)
5. [Implementation Checklist](#5-implementation-checklist)
6. [Architecture Notes](#6-architecture-notes)
7. [Success Criteria](#7-success-criteria)

---

## 1. Desired End State

The user wants to:

1. **Point at a project directory** (e.g., `/Volumes/VRAM/10-19_Work/10_Hacker_Valley_Media/.../hvm-website-payloadcms/`)
2. **Scan the N most recent sessions** across Claude, Codex, and Gemini that relate to that project
3. **Score, chunk, and assess** those sessions using multi-agent consensus (Claude + Codex + Gemini CLIs)
4. **Distill the best parts** — decisions, patterns, architecture, successful implementations, file paths, key learnings
5. **Generate a natural conversation JSONL** that Claude Code can resume with `claude --resume`
6. **The result:** Claude has perfect project context. Design, deployment, features — it gets each request right on the first try.

### What "Perfect" Looks Like

- User runs: `:distill build --cwd /path/to/project --limit 20`
- System scans 20 most recent sessions touching that project
- System scores events, builds chunks, assesses with 3 providers
- System distills the top-scoring content within an 80K token budget
- System generates a Claude Code JSONL with natural user/assistant turns
- User runs: `claude --resume <generated-session-id>`
- Claude responds with full project awareness — no re-explanation needed

---

## 2. Current State Analysis

### What Works (PRD #2, Phases 1-9)

| Component | File | Status |
|-----------|------|--------|
| Session scanner | `src/scanner/scanner.ts` | Scans all platforms by glob patterns |
| Platform parsers | `src/parsers/claude,codex,gemini` | Parse JSONL/JSON into `ParsedEvent[]` |
| Importance scoring | `src/scoring/importance.ts` | Scores events 0-100 with base+bonus |
| Chunk builder | `src/scoring/chunker.ts` | Groups scored events into assessment-ready chunks |
| Multi-agent assessor | `src/assessment/assessor.ts` | Spawns provider CLIs for 0-10 ratings |
| Consensus scoring | `src/assessment/consensus.ts` | Weighted average with outlier rejection |
| Distiller | `src/distiller/distiller.ts` | Filters, sorts, selects within token budget |
| Query distiller | `src/distiller/queryDistiller.ts` | Dual FTS+ClaudeMem search with question-aware ranking |
| Claude output generator | `src/output/claudeGenerator.ts` | Generates JSONL output |
| SQLite storage | `src/storage/sqlite.ts` | WAL-mode DB with FTS5 tables |
| ClaudeMem client | `src/memory/claudeMemClient.ts` | HTTP client for semantic search |
| REPL commands | `src/repl.ts` | `:distill run`, `:distill ask`, `:distill status` |

### What Doesn't Work

The pipeline components exist individually but the end-to-end flow has critical gaps that prevent the desired outcome. See Gap Analysis below.

---

## 3. Gap Analysis

### GAP-1: `:distill run` Does Not Persist Chunks to SQLite FTS

**Severity:** CRITICAL (blocks all FTS queries)

**Current:** The `:distill run` handler in `repl.ts` runs the full pipeline in-memory (parse → score → chunk → assess → consensus → distill) but **never writes chunks or their content to the `chunks` or `chunk_fts` SQLite tables**. The `distillMigrations.ts` creates these tables, but no code ever INSERTs into them.

**Evidence:** User ran `:distill ask "What are the key decisions..."` and got `0 FTS matches`. The `chunk_fts` table is empty because nothing writes to it.

**Fix:** After assessment and consensus, persist each chunk (id, sessionId, content, consensusScore, importanceAvg, tokenEstimate) to the `chunks` table and its searchable content to `chunk_fts`.

---

### GAP-2: No Project-Directory Scoped Session Filtering

**Severity:** CRITICAL (blocks project-specific distillation)

**Current:** `scanSessions()` in `scanner.ts` accepts `ScanOptions` with `platforms`, `minFileSize`, and `limit` — but has no concept of filtering by project directory/CWD. All sessions for all projects are returned.

**Evidence:** `PLATFORM_SESSION_PATHS` in `paths.ts` uses glob patterns like `~/.claude/projects/*/sessions/*.jsonl` which match ALL projects.

**Fix:** Add a `projectPath` or `cwd` option to `ScanOptions`. For Claude sessions, resolve the project directory hash and filter to only matching session directories.

---

### GAP-3: Claude Project Hash → Directory Resolution

**Severity:** CRITICAL (required by GAP-2)

**Current:** Claude Code stores sessions under hashed project paths: `~/.claude/projects/<base64-or-hash>/sessions/`. There is no utility to resolve a real directory path (e.g., `/Volumes/VRAM/.../hvm-website-payloadcms/`) to the corresponding Claude project hash directory.

**Evidence:** Claude's project path encoding uses the format visible in `~/.claude/projects/` directory names. The scanner globs `*/sessions/*.jsonl` without understanding which `*` maps to which project.

**Fix:** Implement a `resolveClaudeProjectDir(cwd: string): string[]` function that:
1. Lists all directories under `~/.claude/projects/`
2. Decodes each directory name to recover the original path
3. Returns matches for the given CWD (exact or prefix match)

Claude encodes the project path by replacing `/` with `-` in the directory name. The function should also handle checking `.claude/projects/*/project.json` or similar metadata files if they exist.

---

### GAP-4: Output Format Is Summary Blocks, Not Natural Conversation

**Severity:** HIGH (degrades `--resume` quality)

**Current:** `claudeGenerator.ts` outputs events with:
- `type: "summary"` (not `user` or `assistant`)
- `is_sidechain: true`
- `compact_boundary: true`
- Content wrapped in `<system-reminder>` tags
- `role: "system"` or `"assistant"`

This is Claude Code's auto-compaction format. While Claude can parse it, it treats these as compressed context, not as a conversation it participated in. The result is that Claude doesn't have the same "ownership" of the project knowledge — it reads it as third-party summary rather than first-person experience.

**Evidence:** Examining `claudeGenerator.ts` lines 30-62 — all events are wrapped as summary/system blocks.

**Fix:** Create a new output generator (`src/output/conversationGenerator.ts`) that produces natural conversation-style JSONL:
- User messages as `type: "user"` with `message.role: "user"`
- Assistant messages as `type: "assistant"` with `message.role: "assistant"` and proper `content` blocks
- Include `uuid`, `parentUuid` chain for conversation threading
- Include `cwd`, `sessionId`, `timestamp` fields
- Optionally include a single `type: "summary"` preamble with project metadata
- The conversation should read as if Claude already worked on this project and has institutional memory

---

### GAP-5: Two-Step Workflow (`:distill run` Then `:distill ask`)

**Severity:** HIGH (UX friction)

**Current:** The user must:
1. Run `:distill run --platform claude --limit 20` to process sessions (but this doesn't persist — see GAP-1)
2. Run `:distill ask "question" --platform claude` to query the processed data

This two-step requirement is not documented and not intuitive. The user tried `:distill ask` directly and got 0 results.

**Fix:** Create a unified `:distill build` command that:
1. Scans sessions (with project-directory filtering)
2. Parses, scores, chunks, assesses
3. Persists to SQLite FTS
4. Distills best content
5. Generates conversation JSONL
6. Reports output file path

One command, one output. The existing `:distill run` and `:distill ask` remain for power users who want incremental control.

---

### GAP-6: Session Limit and Recency Control Not Wired to Distill Commands

**Severity:** MEDIUM

**Current:** The `parseAskArgs()` in `parse.ts` accepts `--platform` and `--providers` but NOT `--limit`, `--recent`, or `--cwd`. The scanner's `ScanOptions.limit` exists but isn't exposed through the REPL command grammar.

**Fix:** Extend command grammar for `:distill` commands to accept:
- `--cwd <path>` — project directory filter
- `--limit <n>` — max sessions to process (default: 20)
- `--budget <tokens>` — token budget for output (default: 80000)
- `--output <path>` — output file path (default: auto-generated)

---

### GAP-7: No Conversation Synthesis / Narrative Assembly

**Severity:** HIGH (quality of output)

**Current:** The distiller selects chunks by score and reassembles chronologically. But the output is a flat concatenation of chunk content — there's no synthesis step that:
- Deduplicates overlapping information across chunks
- Resolves contradictions (earlier decision overridden by later one)
- Structures knowledge by topic (architecture, file paths, patterns, decisions)
- Creates a coherent narrative that flows naturally

**Fix:** Add a synthesis step between distillation and generation:
1. Group distilled chunks by topic/domain using lightweight LLM classification
2. Within each group, deduplicate and resolve contradictions (latest wins)
3. Order groups logically: project overview → architecture → key files → patterns → recent decisions
4. Generate the conversation as a structured dialogue where the "user" asks about each topic and the "assistant" provides the synthesized knowledge

---

### GAP-8: ClaudeMem Observation Density for Specific Projects

**Severity:** LOW (enhancement)

**Current:** `searchAsChunks()` in `defensiveMem.ts` queries ClaudeMem's semantic search, but the observation density for specific projects depends on what was previously stored. Only 1 match was returned for the HVM project query.

**Fix:** During `:distill build`, after assessment:
1. Store high-scoring chunks as ClaudeMem observations with project-path tags
2. This enriches the semantic search index for future `:distill ask` queries
3. Tag observations with `project:<path>` for scoped retrieval

---

### GAP-9: `claude --resume` Compatibility Unverified

**Severity:** HIGH (blocks primary use case)

**Current:** The generated JSONL has never been tested with `claude --resume <session-id>`. The format may need specific fields, ordering, or structure that the current generator doesn't produce.

**Evidence:** Real Claude Code JSONL events have fields including: `type`, `message.role`, `message.content` (array of content blocks), `uuid`, `parentUuid`, `isSidechain`, `cwd`, `sessionId`, `version`, `gitBranch`, `agentId`, `timestamp`. The current generator may not produce all required fields.

**Fix:**
1. Document the exact Claude Code JSONL schema required for `--resume`
2. Generate test JSONL and verify it loads correctly with `claude --resume`
3. Iterate on format until Claude picks up the conversation naturally
4. Add an integration test that generates JSONL and validates with `claude --resume --print-only` or similar

---

### GAP-12: No Natural Language Filtering for Distill Commands

**Severity:** HIGH (UX friction — agentic tools should accept natural language)

**Current:** All distill commands require explicit flags (`--cwd`, `--limit`, `--budget`, `--providers`). Users must know the exact flag syntax to scope queries. There is no way to say "conversations from the last two weeks about railway for the HVM project, most recent 20" and have the system figure out the right filters.

**Evidence:** User tried `:distill run` without flags and got 11,050 sessions. The `:distill build` command has good defaults but still requires knowing `--cwd /path/to/project` syntax. Natural language is the native interface for an agentic tool.

**Fix:** Add a natural language filter that:
1. Accepts free-form text describing the desired scope
2. Spawns a provider CLI with a structured prompt that extracts filter parameters
3. Returns structured `DistillFilterParams` (cwd, limit, since/until dates, keywords, providers)
4. Keywords are used for post-scan FTS filtering on chunk content
5. Wire as `:distill filter "<text>"` command and `--filter` flag on `:distill build`

---

### GAP-10: No Preview/Review Before Generation

**Severity:** LOW (nice-to-have)

**Current:** No way to preview what content was selected before generating the final JSONL. User can't approve/reject specific chunks.

**Fix:** Add a `:distill preview` command or `--dry-run` flag that shows:
- Number of sessions scanned
- Number of chunks selected
- Top chunks by score with content preview
- Total token estimate
- Projected output file size

---

### GAP-11: No End-to-End Integration Tests

**Severity:** MEDIUM

**Current:** Individual components have some test coverage, but there is no integration test that runs the full pipeline: scan → parse → score → chunk → assess → consensus → distill → generate → verify output format.

**Fix:** Create `tests/e2e/distill-build.test.ts` that:
1. Uses fixture session files (Claude, Codex, Gemini format)
2. Runs the full pipeline with mock assessors (skip real CLI spawning)
3. Verifies output JSONL structure matches Claude Code schema
4. Verifies token budget is respected
5. Verifies project-directory filtering works

---

## 4. Implementation Phases

### Phase 10: Foundation — Persistence & Project Scoping

**Goal:** Fix the critical data flow gaps so the pipeline actually stores and retrieves data.

| Step | Description | Gap |
|------|-------------|-----|
| 10.1 | Persist chunks to `chunks` table after assessment | GAP-1 |
| 10.2 | Persist chunk content to `chunk_fts` table | GAP-1 |
| 10.3 | Implement `resolveClaudeProjectDir()` | GAP-3 |
| 10.4 | Add `projectPath`/`cwd` to `ScanOptions` | GAP-2 |
| 10.5 | Filter sessions by resolved project directory | GAP-2 |
| 10.6 | Add `--cwd`, `--limit`, `--budget`, `--output` to command grammar | GAP-6 |
| 10.7 | Unit tests for persistence and project resolution | GAP-11 |

### Phase 11: Conversation-Quality Output

**Goal:** Generate JSONL that Claude treats as first-person experience, not third-party summary.

| Step | Description | Gap |
|------|-------------|-----|
| 11.1 | Document Claude Code JSONL schema for `--resume` | GAP-9 |
| 11.2 | Create `conversationGenerator.ts` | GAP-4 |
| 11.3 | Implement uuid/parentUuid threading | GAP-4 |
| 11.4 | Generate proper content blocks (text, tool_use, tool_result) | GAP-4 |
| 11.5 | Test with `claude --resume` and verify context pickup | GAP-9 |
| 11.6 | Iterate on format based on resume testing | GAP-9 |

### Phase 12: Synthesis & Narrative Assembly

**Goal:** Transform raw distilled chunks into coherent, structured project knowledge.

| Step | Description | Gap |
|------|-------------|-----|
| 12.1 | Implement topic classifier for distilled chunks | GAP-7 |
| 12.2 | Implement deduplication within topic groups | GAP-7 |
| 12.3 | Implement contradiction resolution (latest wins) | GAP-7 |
| 12.4 | Implement narrative ordering logic | GAP-7 |
| 12.5 | Generate structured user/assistant dialogue | GAP-7 |

### Phase 13: Unified Command & Polish

**Goal:** One command does everything. Preview, build, resume.

| Step | Description | Gap |
|------|-------------|-----|
| 13.1 | Implement `:distill build` command | GAP-5 |
| 13.2 | Wire full pipeline: scan → parse → score → chunk → assess → persist → distill → synthesize → generate | GAP-5 |
| 13.3 | Implement `--dry-run` / `:distill preview` | GAP-10 |
| 13.4 | Store high-scoring chunks as ClaudeMem observations | GAP-8 |
| 13.5 | End-to-end integration test with fixture data | GAP-11 |
| 13.6 | Smoke test: build for real project, resume with claude | GAP-9 |

### Phase 14: Natural Language Filtering

**Goal:** Accept plain English descriptions of desired scope and convert them into structured filter parameters using LLM inference.

| Step | Description | Gap |
|------|-------------|-----|
| 14.1 | Define `DistillFilterParams` interface | GAP-12 |
| 14.2 | Create `naturalFilter.ts` with LLM-based NL→params extraction | GAP-12 |
| 14.3 | Build structured prompt for filter extraction | GAP-12 |
| 14.4 | Parse LLM JSON response into `DistillFilterParams` | GAP-12 |
| 14.5 | Add `--since`/`--until` date filtering to scanner | GAP-12 |
| 14.6 | Add FTS keyword filtering after scan | GAP-12 |
| 14.7 | Add `:distill filter` command and `--filter` flag | GAP-12 |
| 14.8 | Wire NL filter through `:distill build` pipeline | GAP-12 |
| 14.9 | Unit tests for NL filter parsing and date extraction | GAP-12 |
| 14.10 | Integration test: NL filter → build pipeline | GAP-12 |

---

## 5. Implementation Checklist

Each item is a single, independently verifiable task.

### Phase 10: Foundation — Persistence & Project Scoping

- [x] **10.1** Add `persistChunk(chunk: Chunk, consensusScore: number)` method to `SessionDb` that INSERTs into `chunks` table
- [x] **10.2** Add `persistChunkFTS(chunkId: string, content: string)` method to `SessionDb` that INSERTs into `chunk_fts` table
- [x] **10.3** Update `:distill run` handler in `repl.ts` to call `persistChunk()` and `persistChunkFTS()` after consensus scoring
- [ ] **10.4** Verify FTS queries return results after `:distill run` by running `:distill ask` and confirming non-zero FTS matches
- [x] **10.5** Create `src/scanner/projectResolver.ts` with `resolveClaudeProjectDir(cwd: string): string[]` function
- [x] **10.6** Read `~/.claude/projects/` directory listing and decode directory names to recover original paths
- [x] **10.7** Handle edge cases: symlinks, multiple matches, non-existent directories
- [x] **10.8** Add `projectPath?: string` field to `ScanOptions` interface in `scanner.ts`
- [x] **10.9** Implement project-directory filtering in `scanSessions()` for Claude sessions using `getProjectSessionDirs()`
- [x] **10.10** Implement project-directory filtering for Codex sessions (global storage — content-based CWD filtering deferred to parse time)
- [x] **10.11** Implement project-directory filtering for Gemini sessions (global storage — content-based CWD filtering deferred to parse time)
- [x] **10.12** Add `cwd` field to `DistillAskCommand` and `DistillRunCommand` in `parse.ts` command grammar
- [x] **10.13** Add `limit` field to distill commands in `parse.ts` (default: 20)
- [x] **10.14** Add `budget` field to distill commands in `parse.ts` (default: 80000)
- [x] **10.15** Add `output` field to distill commands in `parse.ts` (optional output path)
- [x] **10.16** Update `parseDistillFlags()` shared helper for `--cwd`, `--limit`, `--budget`, `--output` flags
- [x] **10.17** Wire new flags through `:distill run` handler to `scanSessions()` and `distill()`
- [x] **10.18** Write unit test: `persistChunk` writes to chunks table and is retrievable
- [x] **10.19** Write unit test: `persistChunkFTS` enables full-text search queries
- [x] **10.20** Write unit test: `resolveClaudeProjectDir` correctly maps real directory to Claude project hash
- [x] **10.21** Write unit test: `scanSessions` with `projectPath` returns only matching sessions
- [x] **10.22** Write unit test: command parser handles `--cwd`, `--limit`, `--budget`, `--output` flags

### Phase 11: Conversation-Quality Output

- [x] **11.1** Examine 3+ real Claude Code session files to document the exact JSONL event schema required for `--resume`
- [x] **11.2** Document required fields: `type`, `message`, `uuid`, `parentUuid`, `sessionId`, `timestamp`, `cwd`, `version`
- [x] **11.3** Document required `message.content` block types: `text`, `tool_use`, `tool_result`
- [x] **11.4** Create `src/output/conversationGenerator.ts` implementing the `SessionGenerator` interface
- [x] **11.5** Implement `generatePreamble()` — first event is a user message establishing project context
- [x] **11.6** Implement `generateUserTurn(topic: string)` — creates a user message asking about a topic
- [x] **11.7** Implement `generateAssistantTurn(chunks: Chunk[])` — creates an assistant response with proper content blocks
- [x] **11.8** Implement uuid chain: each event gets a `uuid`, `parentUuid` points to previous event
- [x] **11.9** Implement `sessionId` generation for the output file (matches Claude Code format)
- [x] **11.10** Implement `cwd` field population from the project directory
- [x] **11.11** Implement `timestamp` field with realistic timestamps (spaced apart naturally)
- [x] **11.12** Add `format` option to distill commands: `--format conversation` (new) vs `--format summary` (existing)
- [ ] **11.13** Generate a test JSONL using `conversationGenerator` with fixture data
- [ ] **11.14** Test: copy generated JSONL to `~/.claude/projects/<hash>/sessions/` and run `claude --resume`
- [ ] **11.15** Verify Claude picks up project context from the generated conversation
- [ ] **11.16** Iterate on JSONL format if Claude doesn't recognize the conversation correctly
- [x] **11.17** Write unit test: generated JSONL has valid event structure for every event
- [x] **11.18** Write unit test: uuid chain is consistent (no orphaned parentUuid references)
- [x] **11.19** Write unit test: token estimate of output respects budget parameter

### Phase 12: Synthesis & Narrative Assembly

- [x] **12.1** Define topic taxonomy: `architecture`, `file-structure`, `patterns`, `decisions`, `dependencies`, `deployment`, `recent-changes`, `known-issues`
- [x] **12.2** Implement `classifyChunkTopic(chunk: Chunk): string` using keyword matching (fast, no LLM needed for v1)
- [x] **12.3** Implement `groupByTopic(chunks: Chunk[]): Map<string, Chunk[]>` to organize distilled content
- [x] **12.4** Implement `deduplicateWithinGroup(chunks: Chunk[]): Chunk[]` using content similarity (Jaccard on token sets)
- [x] **12.5** Implement `resolveContradictions(chunks: Chunk[]): Chunk[]` — when same topic has conflicting info, keep latest by timestamp
- [x] **12.6** Define narrative ordering: overview → architecture → files → patterns → dependencies → deployment → decisions → recent changes → issues
- [x] **12.7** Implement `assembleSynthesis(groups: Map<string, Chunk[]>): SynthesizedTopic[]` that orders and merges
- [x] **12.8** Implement `generateConversationFromSynthesis(topics: SynthesizedTopic[]): ConversationEvent[]` that creates natural Q&A turns per topic
- [x] **12.9** Write unit test: classifier assigns correct topics to known chunk content
- [x] **12.10** Write unit test: deduplication removes overlapping chunks within a topic
- [x] **12.11** Write unit test: contradiction resolution keeps latest information

### Phase 13: Unified Command & Polish

- [x] **13.1** Add `distill_build` command kind to `parse.ts` command grammar
- [x] **13.2** Implement `parseDistillBuildArgs()` for `:distill build --cwd <path> [--limit N] [--budget N] [--output path] [--format conversation|summary] [--providers claude,codex,gemini] [--dry-run]`
- [x] **13.3** Implement `:distill build` handler in `repl.ts` that orchestrates full pipeline
- [x] **13.4** Pipeline step 1: `scanSessions({ projectPath, limit, platforms })` — scan with project filter
- [x] **13.5** Pipeline step 2: Parse all matching sessions into `ParsedEvent[]`
- [x] **13.6** Pipeline step 3: Score all events with `scoreEvent()`
- [x] **13.7** Pipeline step 4: Build chunks with `buildChunks()`
- [x] **13.8** Pipeline step 5: Assess chunks with `assessChunks()` using selected providers
- [x] **13.9** Pipeline step 6: Compute consensus with `computeConsensus()`
- [x] **13.10** Pipeline step 7: Persist chunks and FTS content to SQLite
- [x] **13.11** Pipeline step 8: Distill with `distill()` using token budget
- [x] **13.12** Pipeline step 9: Synthesize with narrative assembly
- [x] **13.13** Pipeline step 10: Generate JSONL with `conversationGenerator`
- [x] **13.14** Pipeline step 11: Write output file and report path + stats
- [x] **13.15** Implement `--dry-run` flag that runs steps 1-8, prints stats, and stops before generation
- [x] **13.16** Implement `:distill preview` as alias for `:distill build --dry-run`
- [x] **13.17** After successful build, store top-scoring chunks as ClaudeMem observations tagged with `project:<cwd>`
- [x] **13.18** Add progress reporting during build (e.g., "Scanning sessions... 20 found", "Assessing chunks... 15/30", "Generating output... 45,000 tokens")
- [x] **13.19** Write end-to-end integration test with fixture session files (mock assessor, no real CLI spawning)
- [x] **13.20** Integration test verifies: correct number of sessions scanned, chunks created, output format valid
- [ ] **13.21** Smoke test: run `:distill build --cwd <real-project>` against real session files
- [ ] **13.22** Smoke test: verify generated JSONL works with `claude --resume`
- [x] **13.23** Update README.md with `:distill build` documentation and usage examples
- [x] **13.24** Update TODO.md to reflect Phase 10-13 items (N/A — no TODO.md exists; PRD serves as tracker)

### Phase 14: Natural Language Filtering

- [x] **14.1** Define `DistillFilterParams` interface: `{ cwd?, limit?, since?, until?, keywords?, providers?, budget?, format? }`
- [x] **14.2** Create `src/distiller/naturalFilter.ts` module
- [x] **14.3** Implement `buildFilterExtractionPrompt(naturalLanguage: string, today: string)` — structured prompt telling LLM about available filter dimensions, requesting JSON output
- [x] **14.4** Implement `parseFilterResponse(llmOutput: string): DistillFilterParams` — extract JSON from LLM response with fallback parsing
- [x] **14.5** Implement `extractFilters(naturalLanguage: string, provider: string): Promise<DistillFilterParams>` — spawns provider CLI, returns parsed params
- [x] **14.6** Add `since?: string` and `until?: string` (ISO date) fields to `ScanOptions` and implement date filtering in `scanSessions()`
- [x] **14.7** Add post-scan FTS keyword filtering: when `keywords` are present, search `chunk_fts` and filter chunks to only those matching keywords
- [x] **14.8** Add `distill_filter` command kind to `parse.ts` for `:distill filter "<text>"`
- [x] **14.9** Add `--filter "<text>"` flag to `distill_build` command in `parse.ts`
- [x] **14.10** Implement `:distill filter` handler in `repl.ts` — calls `extractFilters()`, displays extracted params, then runs build pipeline
- [x] **14.11** Wire `--filter` flag through `:distill build` handler — when present, run NL extraction before pipeline
- [x] **14.12** Update `:help` text with `:distill filter` command
- [x] **14.13** Update README.md with natural language filter documentation and examples
- [x] **14.14** Write unit test: `buildFilterExtractionPrompt` produces valid prompt with all dimensions
- [x] **14.15** Write unit test: `parseFilterResponse` handles valid JSON, markdown-wrapped JSON, and malformed input
- [x] **14.16** Write unit test: date filtering in `scanSessions` respects `since`/`until` bounds
- [x] **14.17** Write integration test: NL filter → extracted params → build pipeline executes correctly

---

## 6. Architecture Notes

### Data Flow

```
User: :distill build --cwd /path/to/project --limit 20

                    ┌──────────────────────────────────────┐
                    │          SESSION DISCOVERY            │
                    │                                       │
                    │  resolveClaudeProjectDir(cwd)         │
                    │         ↓                             │
                    │  scanSessions({ projectPath, limit }) │
                    │         ↓                             │
                    │  [ScannedSession x 20]                │
                    └──────────────┬───────────────────────┘
                                   ↓
                    ┌──────────────────────────────────────┐
                    │         PARSE & SCORE                 │
                    │                                       │
                    │  for each session:                    │
                    │    detectParser() → parse()           │
                    │    scoreEvent() for each event        │
                    │    buildChunks()                      │
                    │         ↓                             │
                    │  [Chunk x ~150]                       │
                    └──────────────┬───────────────────────┘
                                   ↓
                    ┌──────────────────────────────────────┐
                    │         MULTI-AGENT ASSESSMENT        │
                    │                                       │
                    │  assessChunks() with 3 providers     │
                    │  computeConsensus() per chunk         │
                    │  persistChunk() → SQLite              │
                    │  persistChunkFTS() → FTS5             │
                    │         ↓                             │
                    │  [AssessedChunk x ~150]               │
                    └──────────────┬───────────────────────┘
                                   ↓
                    ┌──────────────────────────────────────┐
                    │         DISTILL & SYNTHESIZE          │
                    │                                       │
                    │  distill({ budget: 80000 })          │
                    │  classifyChunkTopic()                 │
                    │  groupByTopic()                       │
                    │  deduplicateWithinGroup()             │
                    │  resolveContradictions()              │
                    │  assembleSynthesis()                  │
                    │         ↓                             │
                    │  [SynthesizedTopic x ~8]              │
                    └──────────────┬───────────────────────┘
                                   ↓
                    ┌──────────────────────────────────────┐
                    │         GENERATE CONVERSATION         │
                    │                                       │
                    │  generateConversationFromSynthesis()  │
                    │  Write .jsonl to output path          │
                    │  Store observations in ClaudeMem      │
                    │         ↓                             │
                    │  ~/.claude/projects/<hash>/sessions/  │
                    │  <generated-session-id>.jsonl         │
                    └──────────────────────────────────────┘
                                   ↓
                    User: claude --resume <generated-session-id>
                    Claude: "I have full context on this project..."
```

### Key Design Decisions

1. **Conversation format over summary format** — Claude treats conversation history as first-person experience. Summary blocks are treated as compressed third-party context. The conversation format produces better results for `--resume`.

2. **Topic-based synthesis over chronological concatenation** — Raw chronological output has redundancy and contradictions. Topic-based synthesis organizes knowledge the way Claude needs it: "What is this project's architecture?" → clear answer, not scattered fragments.

3. **One command for the full pipeline** — The two-step `:distill run` then `:distill ask` flow is an implementation detail, not a user-facing workflow. Power users can still use individual commands, but the default is `:distill build` for the complete pipeline.

4. **Project-directory filtering at scan time** — Filtering after scanning wastes compute on irrelevant sessions. Resolving the Claude project hash up front means we only read session files that belong to the target project.

5. **Persist to SQLite during build** — Even though `:distill build` generates output directly, persisting to SQLite enables future `:distill ask` queries without re-processing.

### Claude Code JSONL Schema (for `--resume`)

Based on analysis of real Claude Code session files:

```typescript
interface ClaudeCodeEvent {
  type: "user" | "assistant" | "summary";
  message: {
    role: "user" | "assistant";
    content: string | ContentBlock[];
  };
  uuid: string;           // UUIDv4
  parentUuid: string;     // Previous event's uuid (empty for first)
  isSidechain: boolean;   // false for main conversation
  cwd: string;            // Project working directory
  sessionId: string;      // Session identifier
  version: string;        // e.g., "1.0.0"
  timestamp: string;      // ISO 8601
  gitBranch?: string;     // Current git branch
  agentId?: string;       // Agent identifier
}

interface ContentBlock {
  type: "text" | "tool_use" | "tool_result";
  text?: string;          // For type: "text"
  id?: string;            // For type: "tool_use"
  name?: string;          // Tool name for type: "tool_use"
  input?: object;         // Tool input for type: "tool_use"
  tool_use_id?: string;   // For type: "tool_result"
  content?: string;       // For type: "tool_result"
}
```

---

## 7. Success Criteria

| # | Criterion | Verification |
|---|-----------|-------------|
| 1 | `:distill build --cwd <path>` completes without error | Run command, check exit status |
| 2 | Only sessions from specified project directory are processed | Check scan log for session paths |
| 3 | Chunks are persisted to SQLite after build | Query `SELECT count(*) FROM chunks` |
| 4 | FTS queries return results after build | Run `:distill ask` and verify non-zero FTS matches |
| 5 | Generated JSONL has valid Claude Code event structure | Parse output, validate all required fields |
| 6 | `claude --resume` with generated JSONL gives Claude project context | Ask Claude about the project, verify it knows architecture/files/decisions |
| 7 | Output stays within token budget (default 80K) | Count tokens in output file |
| 8 | Synthesis deduplicates overlapping content | Compare output token count to raw concatenation |
| 9 | End-to-end test passes with fixture data | Run `bun test tests/e2e/distill-build.test.ts` |
| 10 | ClaudeMem observations stored after successful build | Query ClaudeMem for project-tagged observations |

---

## Appendix: File Change Map

| File | Change Type | Phase |
|------|-------------|-------|
| `src/storage/sqlite.ts` | Modify — add `persistChunk()`, `persistChunkFTS()` | 10 |
| `src/repl.ts` | Modify — update `:distill run` handler, add `:distill build` handler | 10, 13 |
| `src/scanner/projectResolver.ts` | **NEW** — Claude project hash resolution | 10 |
| `src/scanner/scanner.ts` | Modify — add `projectPath` filtering | 10 |
| `src/scanner/paths.ts` | Modify — add `projectPath` to `ScanOptions` | 10 |
| `src/commands/parse.ts` | Modify — add `--cwd`, `--limit`, `--budget`, `--output`, `--format` flags | 10, 13 |
| `src/output/conversationGenerator.ts` | **NEW** — natural conversation JSONL output | 11 |
| `src/distiller/synthesizer.ts` | **NEW** — topic classification, dedup, narrative assembly | 12 |
| `tests/unit/persistence.test.ts` | **NEW** — chunk persistence tests | 10 |
| `tests/unit/projectResolver.test.ts` | **NEW** — project hash resolution tests | 10 |
| `tests/unit/conversationGenerator.test.ts` | **NEW** — output format tests | 11 |
| `tests/unit/synthesizer.test.ts` | **NEW** — synthesis logic tests | 12 |
| `tests/e2e/distill-build.test.ts` | **NEW** — end-to-end integration test | 13 |
| `README.md` | Modify — add `:distill build` docs | 13 |
| `TODO.md` | Modify — add Phase 10-13 items | 13 |
