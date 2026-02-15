# Conversation Distillation & Session Rebuild — Unified Implementation Plan

> **Status**: Draft
> **Date**: 2026-02-14
> **PRD #**: 2
> **Synthesizes**: JSONL-Conversation-Distillation-Implementation-Plan.md + Real-Time-Conversation-Rebuild-PRD.md
> **Depends on**: PRD #1 (SDK URL Multi-Model Unification — implemented)
> **Estimated new code**: ~1,650 lines TypeScript
> **Reuse from existing unified-agent**: ~55%

---

## 1. Executive Summary

This plan merges two complementary research documents into a single implementation strategy that extends the existing unified-agent codebase with conversation distillation, real-time importance scoring, cross-platform session ingestion, multi-agent assessment, and fresh session generation capabilities.

**Architecture Decision**: Extend unified-agent directly (not a standalone tool). The codebase already provides multi-provider CLI spawning, dual JSONL+SQLite persistence, WebSocket gateway, ClaudeMem integration, adapter normalization, and streaming command infrastructure — approximately 80% of the required foundation.

**Core Value Proposition**: Transform raw, noisy multi-provider conversation sessions into distilled, high-signal context that can be injected into fresh sessions across any supported platform (Claude, Codex, Gemini). Critically, the system supports **question-driven assembly** — given a specific user question, it searches both SQLite FTS and ClaudeMem for the most relevant conversation chunks, re-ranks them using question-aware multi-agent assessment, and generates a fresh session file optimized for answering that question.

---

## 2. Source Document Cross-Reference

| Concern | JSONL Distillation Plan | Real-Time Rebuild PRD | This Plan |
|---|---|---|---|
| Architecture | Standalone `session-distiller` | Extend unified-agent | **Extend unified-agent** |
| Parsing | Standalone streaming parsers | Reuse existing session types | **New `src/parsers/` with 3 platform parsers** |
| Scoring | Base 50 + type/tool/error bonuses | Intercept `recordEvent()` real-time | **Both: real-time intercept + batch re-score** |
| Assessment | Parallel `Bun.spawn` multi-agent | Background watcher + assessor | **Parallel Bun.spawn via existing provider adapters** |
| Storage | Standalone SQLite | Extend `sessions.db` with new tables | **Extend existing `sessions.db`** |
| Memory | Direct ClaudeMem calls | Defensive wrapper with `_sync_queue` | **Defensive wrapper with `_sync_queue`** |
| Output | Platform-specific generators | Session seed via `compact_boundary` | **Platform-specific generators + compact_boundary** |
| CLI | Standalone binary | `:distill` REPL command family | **`:distill` REPL commands** |
| Question-driven | Not addressed | Not addressed | **`queryDistill()` with FTS + ClaudeMem dual search, question-aware assessment, `:distill ask` command** |
| Reuse | 65% | 55% | **~55% reuse, 20% extend, 25% build** |

---

## 3. Existing Infrastructure Inventory

### 3.1 What We Already Have (Reuse Directly)

| Component | File(s) | Reuse For |
|---|---|---|
| Multi-provider CLI spawning | `src/providers/claudeCli.ts`, `codexCli.ts`, `geminiCli.ts` | Multi-agent assessment (spawn claude/codex/gemini to rate chunks) |
| Streaming command runner | `src/providers/stream.ts` | `runStreamingCommand()` for assessment agent spawning |
| Canonical event types | `src/session/types.ts` | 16 event types already defined; extend with scoring fields |
| Session manager | `src/session/manager.ts` | Intercept `recordEvent()` for real-time scoring |
| Dual persistence | `src/storage/jsonl.ts`, `sqlite.ts` | Extend SQLite schema; JSONL stays as-is |
| ClaudeMem client | `src/memory/claudeMemClient.ts` | Wrap with defensive `_sync_queue` |
| REPL command dispatch | `src/repl.ts`, `src/commands/parse.ts` | Add `:distill` command family |
| Telemetry helpers | `src/providers/telemetry.ts` | `summarizeToolInput/Output()` for assessment prompts |
| Provider adapters | `src/adapters/*.ts` | Route assessment calls through adapter layer |
| Gateway normalizers | `src/gateway/normalizers.ts` | Normalize external session events to canonical form |
| ID generation | `src/util/ids.ts` | `newMetaSessionId()` for distilled session IDs |
| Redaction | `src/util/redact.ts` | Redact sensitive content before assessment |
| Path utilities | `src/util/paths.ts` | `getDataDir()` for scanner discovery |
| Metrics | `src/gateway/metrics.ts` | Extend with distillation counters |

### 3.2 What We Need to Build

| Component | Location | Lines (est.) | Purpose |
|---|---|---|---|
| Claude JSONL parser | `src/parsers/claudeParser.ts` | ~120 | Parse Claude Code `.jsonl` session files |
| Codex JSONL parser | `src/parsers/codexParser.ts` | ~100 | Parse Codex CLI `.jsonl` session files |
| Gemini JSON parser | `src/parsers/geminiParser.ts` | ~100 | Parse Gemini CLI `.json` session files |
| Parser index + types | `src/parsers/index.ts`, `types.ts` | ~60 | Common `ParsedEvent` interface, auto-detect |
| Session scanner | `src/scanner/scanner.ts` | ~80 | Discover session files across platforms |
| Scanner config | `src/scanner/paths.ts` | ~40 | Platform-specific session file locations |
| Importance scorer | `src/scoring/importance.ts` | ~100 | Base score + type/tool/error/pattern bonuses |
| Real-time scoring hook | `src/scoring/realtime.ts` | ~50 | Intercept `SessionManager.recordEvent()` |
| Chunk builder | `src/scoring/chunker.ts` | ~80 | Group scored events into assessment chunks |
| Multi-agent assessor | `src/assessment/assessor.ts` | ~150 | Parallel `Bun.spawn` assessment via providers |
| Assessment prompts | `src/assessment/prompts.ts` | ~60 | Structured rating prompts for each provider |
| Consensus scorer | `src/assessment/consensus.ts` | ~40 | Weighted average across agent ratings |
| Token-budget distiller | `src/distiller/distiller.ts` | ~100 | Select chunks within token budget |
| Claude session generator | `src/output/claudeGenerator.ts` | ~60 | Emit Claude-format JSONL with `compact_boundary` |
| Codex session generator | `src/output/codexGenerator.ts` | ~50 | Emit Codex-format JSONL |
| Gemini session generator | `src/output/geminiGenerator.ts` | ~50 | Emit Gemini-format JSON |
| Output index | `src/output/index.ts` | ~30 | Factory for platform-specific generators |
| Defensive ClaudeMem wrapper | `src/memory/defensiveMem.ts` | ~80 | Write-local-first with `_sync_queue` + `searchAsChunks()` |
| SQLite schema migrations | `src/storage/distillMigrations.ts` | ~70 | New tables: `chunks`, `assessments`, `external_sessions`, `chunk_fts` |
| Question-driven distiller | `src/distiller/queryDistiller.ts` | ~150 | FTS + ClaudeMem dual search, question-weighted consensus, `queryDistill()` |
| Question-aware prompts | `src/assessment/prompts.ts` (extend) | ~40 | `buildQuestionAwarePrompt()` with question injection |
| **Total** | | **~1,650** | |

---

## 4. Data Model Extensions

### 4.1 CanonicalEvent Extensions

Extend `src/session/types.ts` with optional scoring fields on `CanonicalEventBase`:

```typescript
// Added to CanonicalEventBase
importanceScore?: number;        // 0-100, assigned by importance scorer
chunkId?: string;                // Groups events into assessment units
assessmentScores?: Record<string, number>;  // { claude: 8.2, codex: 7.5, gemini: 8.0 }
consensusScore?: number;         // Weighted average of assessment scores
sourceSessionId?: string;        // Original session ID (for external ingestion)
sourcePlatform?: "claude" | "codex" | "gemini";  // Original platform
toolCalls?: { name: string; input?: string; output?: string }[];  // Extracted tool usage
```

### 4.2 New SQLite Tables

Add to `src/storage/sqlite.ts` via `distillMigrations.ts`:

```sql
CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY,
  meta_session_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  start_event_index INTEGER NOT NULL,
  end_event_index INTEGER NOT NULL,
  importance_avg REAL,
  consensus_score REAL,
  token_count INTEGER,
  summary TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (meta_session_id) REFERENCES meta_sessions(id)
);

CREATE TABLE IF NOT EXISTS assessments (
  id TEXT PRIMARY KEY,
  chunk_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  score REAL NOT NULL,
  rationale TEXT,
  model TEXT,
  tokens_used INTEGER,
  latency_ms INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (chunk_id) REFERENCES chunks(id)
);

CREATE TABLE IF NOT EXISTS external_sessions (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  original_path TEXT NOT NULL,
  original_session_id TEXT,
  event_count INTEGER,
  imported_at TEXT DEFAULT (datetime('now')),
  meta_session_id TEXT,
  FOREIGN KEY (meta_session_id) REFERENCES meta_sessions(id)
);

CREATE TABLE IF NOT EXISTS chunk_fts (
  chunk_id TEXT,
  content TEXT
);

CREATE TABLE IF NOT EXISTS _sync_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operation TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  synced_at TEXT
);
```

---

## 5. Component Design

### 5.1 Platform Parsers (`src/parsers/`)

Each parser implements a common interface and emits `ParsedEvent` objects:

```typescript
// src/parsers/types.ts
export interface ParsedEvent {
  type: string;
  role?: "user" | "assistant" | "system" | "tool";
  content: string;
  timestamp?: string;
  toolName?: string;
  toolInput?: string;
  toolOutput?: string;
  isError?: boolean;
  metadata?: Record<string, unknown>;
  rawLine?: string;
}

export interface SessionParser {
  platform: "claude" | "codex" | "gemini";
  parse(source: string | ReadableStream): AsyncGenerator<ParsedEvent>;
  detect(filePath: string): boolean;
}
```

**Claude Parser**: Reads JSONL line-by-line. Maps `type: "assistant"` with `message.content` text blocks to assistant events. Maps `type: "user"` with `tool_result` blocks to tool results. Maps `type: "system"` to system events. Extracts `tool_use` blocks from assistant messages.

**Codex Parser**: Reads JSONL line-by-line. Maps `type: "item.completed"` with `item.type: "command_execution"` to tool events. Maps `type: "item.completed"` with `item.type: "reasoning"` to assistant events. Maps `type: "turn.completed"` to usage tracking.

**Gemini Parser**: Reads JSON (potentially multi-line). Maps `type: "message"` with `role: "assistant"` to assistant events. Maps `type: "tool_call"` / `type: "tool_use"` to tool events. Maps `type: "tool_result"` to tool result events.

**Auto-detection**: `src/parsers/index.ts` exports `detectParser(filePath: string): SessionParser | null` that checks file extension and first-line heuristics.

### 5.2 Session Scanner (`src/scanner/`)

Discovers session files across all three platforms:

```typescript
// src/scanner/paths.ts
export const PLATFORM_SESSION_PATHS = {
  claude: [
    "~/.claude/projects/*/sessions/*.jsonl",   // Claude Code sessions
    "~/.claude/projects/*/*.jsonl",             // Claude Code project-level
  ],
  codex: [
    "~/.codex/sessions/*.jsonl",               // Codex CLI sessions
  ],
  gemini: [
    "~/.gemini/sessions/*.json",               // Gemini CLI sessions
  ],
  unified: [
    "~/.unified-agent/sessions/*.jsonl",       // Unified agent's own sessions
  ],
};

export interface ScannedSession {
  platform: "claude" | "codex" | "gemini" | "unified";
  filePath: string;
  fileSize: number;
  modifiedAt: Date;
  sessionId?: string;
}
```

The scanner resolves `~` to `$HOME`, globs each pattern, and returns `ScannedSession[]` sorted by `modifiedAt` descending.

### 5.3 Importance Scorer (`src/scoring/importance.ts`)

Scores each `ParsedEvent` with a base + bonus system:

```typescript
export interface ScoringConfig {
  baseScore: number;          // Default: 50
  toolUseBonus: number;       // Default: 15
  errorBonus: number;         // Default: 20
  userPromptBonus: number;    // Default: 10
  codeBlockBonus: number;     // Default: 10
  fileEditBonus: number;      // Default: 12
  longContentPenalty: number; // Default: -5 (>2000 chars)
  systemEventPenalty: number; // Default: -20
  hookEventPenalty: number;   // Default: -15
}

export function scoreEvent(event: ParsedEvent, config?: Partial<ScoringConfig>): number;
```

The scorer applies bonuses cumulatively and clamps to 0-100 range.

### 5.4 Real-Time Scoring Hook (`src/scoring/realtime.ts`)

Intercepts `SessionManager.recordEvent()` to score events as they arrive:

```typescript
export function wrapSessionManagerWithScoring(
  manager: SessionManager,
  config?: Partial<ScoringConfig>
): SessionManager;
```

This wraps the original `recordEvent` method. Before persisting, it runs `scoreEvent()` on the canonical event and attaches `importanceScore` to the event payload. No blocking — scoring is synchronous and lightweight (~0.1ms per event).

### 5.5 Chunk Builder (`src/scoring/chunker.ts`)

Groups scored events into assessment-ready chunks:

```typescript
export interface Chunk {
  id: string;
  sessionId: string;
  events: ParsedEvent[];
  startIndex: number;
  endIndex: number;
  importanceAvg: number;
  tokenEstimate: number;
}

export interface ChunkConfig {
  maxEventsPerChunk: number;      // Default: 20
  maxTokensPerChunk: number;      // Default: 4000
  minImportanceThreshold: number; // Default: 30
  overlapEvents: number;          // Default: 2
}

export function buildChunks(
  events: ParsedEvent[],
  config?: Partial<ChunkConfig>
): Chunk[];
```

Chunking strategy:
1. Filter events below `minImportanceThreshold`
2. Group remaining events into windows of `maxEventsPerChunk`
3. Estimate tokens per chunk (rough: `content.length / 4`)
4. Split chunks that exceed `maxTokensPerChunk`
5. Add `overlapEvents` from previous chunk for context continuity
6. Assign each chunk a unique ID via `newRequestId()`

### 5.6 Multi-Agent Assessor (`src/assessment/assessor.ts`)

Spawns parallel assessment calls through the existing provider infrastructure:

```typescript
export interface AssessmentResult {
  provider: "claude" | "codex" | "gemini";
  chunkId: string;
  score: number;        // 1-10
  rationale: string;
  model?: string;
  tokensUsed?: number;
  latencyMs: number;
}

export interface AssessorConfig {
  providers: ("claude" | "codex" | "gemini")[];  // Default: all three
  timeoutMs: number;                              // Default: 30000
  maxConcurrent: number;                          // Default: 3
  retryOnFailure: boolean;                        // Default: true
}

export async function assessChunk(
  chunk: Chunk,
  config?: Partial<AssessorConfig>
): Promise<AssessmentResult[]>;

export async function assessChunks(
  chunks: Chunk[],
  config?: Partial<AssessorConfig>,
  onProgress?: (completed: number, total: number) => void
): Promise<Map<string, AssessmentResult[]>>;
```

Implementation uses `Bun.spawn` via the existing `runStreamingCommand()` from `src/providers/stream.ts`. Each provider receives a structured prompt asking it to rate the chunk 1-10 on:
- **Relevance**: How useful is this for understanding the project/task?
- **Signal density**: Ratio of actionable content vs noise
- **Reusability**: Would this help in a fresh session?

The assessor parses JSON responses from each provider. Failed assessments are logged but don't block others.

### 5.7 Consensus Scorer (`src/assessment/consensus.ts`)

Computes weighted consensus from multi-agent assessments:

```typescript
export interface ConsensusConfig {
  weights: Record<string, number>;  // Default: { claude: 1.0, codex: 1.0, gemini: 1.0 }
  minAssessments: number;           // Default: 2 (at least 2 providers must respond)
  discardOutliers: boolean;         // Default: true (drop scores >2 stddev from mean)
}

export function computeConsensus(
  assessments: AssessmentResult[],
  config?: Partial<ConsensusConfig>
): number;  // Returns 0-10
```

### 5.8 Token-Budget Distiller (`src/distiller/distiller.ts`)

Selects the highest-value chunks that fit within a token budget:

```typescript
export interface DistillerConfig {
  maxTokens: number;              // Default: 80000
  minConsensusScore: number;      // Default: 5.0
  includeSystemContext: boolean;  // Default: true
  sortBy: "consensus" | "chronological" | "hybrid";  // Default: "hybrid"
}

export interface DistilledSession {
  sourceSessionIds: string[];
  sourcePlatforms: string[];
  chunks: Chunk[];
  totalTokens: number;
  droppedChunks: number;
  distilledAt: string;
}

export function distill(
  scoredChunks: Map<string, { chunk: Chunk; consensus: number }>,
  config?: Partial<DistillerConfig>
): DistilledSession;
```

**Hybrid sort** (default): Sorts by `0.7 * normalizedConsensus + 0.3 * normalizedRecency`. This preserves high-signal content while favoring recent context.

### 5.9 Platform Session Generators (`src/output/`)

Each generator transforms a `DistilledSession` into a platform-native session format:

**Claude Generator** (`claudeGenerator.ts`):
- Emits JSONL with `type: "summary"` and `compact_boundary` markers
- Wraps distilled content in `<system-reminder>` blocks (matching Claude Code's auto-compaction format)
- Includes `is_sidechain: true` for injected context

**Codex Generator** (`codexGenerator.ts`):
- Emits Codex-format JSONL with `type: "context"` events
- Includes session metadata as first line

**Gemini Generator** (`geminiGenerator.ts`):
- Emits Gemini-format JSON with conversation history
- Maps chunks to `parts` array structure

**All generators** share a common interface:

```typescript
export interface SessionGenerator {
  platform: "claude" | "codex" | "gemini";
  generate(distilled: DistilledSession, outputPath: string): Promise<string>;
}
```

### 5.10 Defensive ClaudeMem Wrapper (`src/memory/defensiveMem.ts`)

Wraps the existing `ClaudeMemClient` with write-local-first semantics:

```typescript
export class DefensiveClaudeMemClient {
  constructor(
    private inner: ClaudeMemClient,
    private db: SessionDb
  );

  async storeObservation(text: string): Promise<void>;
  async contextInject(projectPath: string): Promise<string>;
  async search(query: string): Promise<ClaudeMemSearchResult[]>;
  async searchAsChunks(query: string, maxResults?: number): Promise<Chunk[]>;
  async flushSyncQueue(): Promise<void>;
  async getSyncQueueSize(): Promise<number>;
}

export interface ClaudeMemSearchResult {
  id: string;
  content: string;
  similarity: number;
  metadata?: Record<string, unknown>;
  createdAt?: string;
}
```

On `storeObservation()`:
1. Write to local `_sync_queue` table immediately (always succeeds)
2. Attempt HTTP POST to ClaudeMem worker
3. If successful, mark queue entry as `synced_at = now()`
4. If failed, leave in queue for background retry

`flushSyncQueue()` retries all unsynced entries. Called periodically from the REPL event loop.

`searchAsChunks()` converts ClaudeMem search results into synthetic `Chunk` objects:
1. Calls `this.inner.search(query)` to get semantic matches
2. Maps each result to a `Chunk` with `id: "mem_" + result.id`, source marked as `"claudemem"`
3. Derives `importanceAvg` from similarity score (0-1 → 0-100)
4. Estimates tokens via `content.length / 4`
5. Returns up to `maxResults` chunks (default: 20), compatible with assessment pipeline

### 5.11 REPL Command Integration

Add `:distill` command family to `src/commands/parse.ts`:

```typescript
// New command kinds
| { kind: "distill_scan" }
| { kind: "distill_run"; sessionIds?: string[]; providers?: string[] }
| { kind: "distill_seed"; platform: string; sessionId?: string }
| { kind: "distill_ask"; question: string; platform?: string; providers?: string[] }
| { kind: "distill_query"; query: string }
| { kind: "distill_report"; sessionId?: string }
| { kind: "distill_assess"; chunkId?: string }
| { kind: "distill_status" }
| { kind: "distill_watch"; enabled: boolean }
```

Command syntax:
- `:distill ask "question" [--platform claude|codex|gemini] [--providers claude,codex,gemini]` — **Question-driven**: Search chunks + ClaudeMem for question-relevant content, re-rank with question-aware assessment, generate fresh platform-specific session file
- `:distill scan` — Scan all platforms for session files
- `:distill run [sessionId...]` — Run full distillation pipeline on specified sessions (or most recent)
- `:distill seed claude|codex|gemini [sessionId]` — Generate a fresh session file for target platform
- `:distill query <text>` — Search distilled chunks by content
- `:distill report [sessionId]` — Show distillation statistics
- `:distill assess [chunkId]` — Trigger multi-agent assessment on specific chunk
- `:distill status` — Show pipeline status (queue, in-progress, completed)
- `:distill watch on|off` — Enable/disable real-time background distillation

### 5.12 Question-Driven Distiller (`src/distiller/queryDistiller.ts`)

The core function that fulfills the original project goal: given a user's question, find the most relevant conversation chunks and assemble them into a fresh session.

```typescript
export interface QueryDistillConfig extends DistillerConfig {
  question: string;                                      // The user's question
  searchSources: "chunks" | "claudemem" | "both";       // Where to find candidates (default: "both")
  queryAssessmentWeight: number;                         // Weight for question-relevance score (default: 0.6)
  staticAssessmentWeight: number;                        // Weight for general importance score (default: 0.4)
  claudeMemMaxResults: number;                           // Max ClaudeMem search results (default: 20)
  reRankWithQuestion: boolean;                           // Re-assess candidates with question context (default: true)
}

export interface QueryDistillResult extends DistilledSession {
  question: string;
  searchStats: {
    chunkFtsMatches: number;       // Chunks found via SQLite FTS
    claudeMemMatches: number;      // Observations found via ClaudeMem search
    totalCandidates: number;       // After merge + dedup
    afterReRank: number;           // After question-aware filtering
  };
}

export async function queryDistill(
  question: string,
  db: SessionDb,
  memClient: DefensiveClaudeMemClient,
  config?: Partial<QueryDistillConfig>
): Promise<QueryDistillResult>;
```

**Pipeline flow**:

1. **Dual search** (parallel):
   - `chunk_fts` FTS query: `SELECT chunk_id, content FROM chunk_fts WHERE chunk_fts MATCH ?` using the question as search terms
   - `memClient.searchAsChunks(question)`: Semantic similarity search against ClaudeMem observations

2. **Merge + Dedup**: Combine both result sets. Deduplicate by content hash (SHA-256 of first 500 chars). Preserve higher-scoring duplicate.

3. **Question-aware re-ranking** (if `reRankWithQuestion` is true):
   - Send each candidate chunk through `buildQuestionAwarePrompt()` to assessment providers
   - Each provider rates the chunk specifically against the question (not generically)
   - Uses existing `assessChunks()` infrastructure with question-aware prompt substitution

4. **Question-weighted consensus**:
   ```
   finalScore = queryAssessmentWeight * questionRelevanceScore
              + staticAssessmentWeight * existingConsensusScore
   ```
   Default: 60% question relevance, 40% general importance

5. **Token-budget selection**: Sort by `finalScore` descending, select top chunks within `maxTokens` budget

6. **Return** `QueryDistillResult` with search stats for transparency

### 5.13 Question-Aware Assessment Prompts (`src/assessment/prompts.ts`)

Extends the existing prompt module with a question-specific variant:

```typescript
export function buildQuestionAwarePrompt(
  chunk: Chunk,
  question: string,
  platform: "claude" | "codex" | "gemini"
): string;
```

**Prompt template**:

```
You are evaluating a conversation chunk for relevance to a specific question.

**Question the user wants to answer:**
{question}

**Conversation chunk (from {sourcePlatform} session):**
---
{chunk.events.map(e => e.content).join("\n")}
---

Rate this chunk 1-10 on each criterion:

1. **Question Relevance**: How directly useful is this chunk for answering the specific question above?
2. **Signal Density**: What ratio of the content is actionable vs noise/boilerplate?
3. **Context Value**: How much essential background does this provide for understanding the answer?

Respond with ONLY this JSON (no markdown, no explanation):
{"questionRelevance": <1-10>, "signalDensity": <1-10>, "contextValue": <1-10>, "overallScore": <1-10>, "rationale": "<one sentence>"}
```

**Key differences from generic prompt** (`buildAssessmentPrompt()`):
- Injects the user's question as primary evaluation context
- Replaces "Reusability" with "Question Relevance" (the most important metric)
- Replaces "Relevance" with "Context Value" (captures supporting chunks that aren't direct answers)
- `overallScore` should weight question relevance highest

### 5.14 `:distill ask` Handler

End-to-end command that takes a question and produces a ready-to-use session file:

**Command syntax**: `:distill ask "How does the adapter pattern work?" --platform claude --providers claude,codex,gemini`

**Handler implementation** (in `src/repl.ts`):

1. Parse question from quoted string, extract optional `--platform` (default: `claude`) and `--providers` flags
2. Call `queryDistill(question, db, memClient, { providers, ... })`
3. Call `getGenerator(platform).generate(result, outputPath)` where `outputPath = ~/.unified-agent/distilled/{timestamp}-{slugifiedQuestion}.{ext}`
4. Display summary:
   ```
   ✓ Question-driven distillation complete
     Question: "How does the adapter pattern work?"
     Sources: 12 FTS matches + 8 ClaudeMem matches → 16 unique candidates
     Selected: 9 chunks (42,300 tokens) from 16 candidates
     Output: ~/.unified-agent/distilled/2026-02-14-adapter-pattern.jsonl

     To use: claude --resume ~/.unified-agent/distilled/2026-02-14-adapter-pattern.jsonl
   ```
5. The output file includes a preamble that sets context: "This session was assembled from distilled conversation chunks relevant to: {question}"

---

## 6. Pipeline Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                     REAL-TIME PATH (during conversation)            │
│                                                                     │
│  User Message → SessionManager.recordEvent()                       │
│                      ↓                                              │
│              realtime.ts (score event)                              │
│                      ↓                                              │
│              Persist with importanceScore                           │
│                      ↓                                              │
│              [Background] chunker → _sync_queue                    │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                     BATCH PATH (`:distill run`)                     │
│                                                                     │
│  Scanner → Parser → Scorer → Chunker → Assessor → Consensus       │
│                                              ↓                      │
│                                      Distiller (token budget)      │
│                                              ↓                      │
│                                      Generator (platform-specific) │
│                                              ↓                      │
│                                      Fresh session file            │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                     BACKGROUND PATH (`:distill watch`)              │
│                                                                     │
│  File watcher on session dirs → Auto-ingest new sessions           │
│                                      ↓                              │
│                              Score + Chunk + Queue for assessment   │
│                                      ↓                              │
│                              Assess when idle (backpressure-aware) │
│                                      ↓                              │
│                              Update SQLite + ClaudeMem sync        │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                  QUESTION-DRIVEN PATH (`:distill ask`)              │
│                                                                     │
│  User Question                                                      │
│       ├──→ chunk_fts FTS search (SQLite full-text)                 │
│       └──→ ClaudeMem search (semantic similarity)                  │
│                      ↓                                              │
│              Merge + Deduplicate candidates                         │
│                      ↓                                              │
│              Question-aware assessment                              │
│              (providers rate chunk vs question)                     │
│                      ↓                                              │
│              Question-weighted consensus                            │
│              (0.6 * questionRelevance + 0.4 * generalConsensus)    │
│                      ↓                                              │
│              Token-budget selection                                 │
│                      ↓                                              │
│              Generator (platform-specific)                          │
│                      ↓                                              │
│              Fresh question-optimized session file                  │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 7. Implementation Checklist

Each item below is an individual, atomic task. No grouping. Items are ordered by dependency (earlier items unblock later ones).

- [x] 1. Create `src/parsers/` directory structure
- [x] 2. Define `ParsedEvent` interface in `src/parsers/types.ts`
- [x] 3. Define `SessionParser` interface in `src/parsers/types.ts`
- [ ] 4. Implement Claude JSONL parser in `src/parsers/claudeParser.ts` — handle `type: "assistant"` with `message.content` text blocks, `type: "user"` with `tool_result`, `type: "system"`, and `tool_use` extraction
- [ ] 5. Implement Codex JSONL parser in `src/parsers/codexParser.ts` — handle `type: "item.completed"` with `command_execution` and `reasoning`, `type: "turn.completed"` for usage
- [ ] 6. Implement Gemini JSON parser in `src/parsers/geminiParser.ts` — handle `type: "message"` with `role: "assistant"`, `type: "tool_call"`, `type: "tool_use"`, `type: "tool_result"`
- [ ] 7. Implement parser auto-detection in `src/parsers/index.ts` — check file extension (`.jsonl` vs `.json`) and first-line structure heuristics
- [ ] 8. Write unit tests for Claude JSONL parser with sample session data
- [ ] 9. Write unit tests for Codex JSONL parser with sample session data
- [ ] 10. Write unit tests for Gemini JSON parser with sample session data
- [ ] 11. Write unit tests for parser auto-detection across all three formats
- [x] 12. Create `src/scanner/` directory structure
- [x] 13. Define `ScannedSession` interface and `PLATFORM_SESSION_PATHS` in `src/scanner/paths.ts`
- [ ] 14. Implement session scanner in `src/scanner/scanner.ts` — glob each platform path, resolve `~`, return sorted `ScannedSession[]`
- [ ] 15. Write unit test for scanner with mocked filesystem paths
- [x] 16. Create `src/scoring/` directory structure
- [x] 17. Define `ScoringConfig` interface in `src/scoring/importance.ts`
- [ ] 18. Implement `scoreEvent()` function with base score + bonus system (toolUse: +15, error: +20, userPrompt: +10, codeBlock: +10, fileEdit: +12, longContent: -5, systemEvent: -20, hookEvent: -15)
- [ ] 19. Implement clamp logic to keep scores in 0-100 range
- [ ] 20. Write unit tests for `scoreEvent()` covering all bonus/penalty paths
- [ ] 21. Implement real-time scoring hook in `src/scoring/realtime.ts` — wrap `SessionManager.recordEvent()` to attach `importanceScore` before persistence
- [ ] 22. Write unit test for real-time scoring hook verifying scores are attached to persisted events
- [x] 23. Define `Chunk` interface and `ChunkConfig` in `src/scoring/chunker.ts`
- [ ] 24. Implement `buildChunks()` — filter below threshold, group into windows, estimate tokens, split oversized chunks, add overlap
- [x] 25. Implement token estimation helper (`content.length / 4` rough approximation)
- [ ] 26. Write unit tests for `buildChunks()` covering threshold filtering, token splitting, and overlap
- [x] 27. Create `src/assessment/` directory structure
- [x] 28. Define `AssessmentResult` and `AssessorConfig` interfaces in `src/assessment/assessor.ts`
- [ ] 29. Implement structured assessment prompt template in `src/assessment/prompts.ts` — include chunk content, ask for 1-10 rating on relevance/signal-density/reusability, request JSON response
- [ ] 30. Implement `assessChunk()` using `runStreamingCommand()` from `src/providers/stream.ts` — spawn one provider CLI per assessment, parse JSON rating from stdout
- [ ] 31. Implement `assessChunks()` with parallel execution — launch up to `maxConcurrent` assessments simultaneously using `Promise.all()` with concurrency limiter
- [ ] 32. Add timeout handling to assessment — abort provider subprocess after `timeoutMs`
- [ ] 33. Add retry logic for failed assessments — one retry per provider per chunk
- [ ] 34. Write unit tests for assessor using mock provider (returns deterministic scores)
- [ ] 35. Define `ConsensusConfig` interface in `src/assessment/consensus.ts`
- [ ] 36. Implement `computeConsensus()` — weighted average with optional outlier discarding (>2 stddev from mean)
- [ ] 37. Write unit tests for consensus scorer covering normal case, outlier rejection, and minimum assessment threshold
- [x] 38. Create `src/distiller/` directory structure
- [x] 39. Define `DistillerConfig` and `DistilledSession` interfaces in `src/distiller/distiller.ts`
- [ ] 40. Implement `distill()` function — sort chunks by hybrid score (0.7 consensus + 0.3 recency), select top chunks within token budget
- [ ] 41. Implement "hybrid" sort normalization — normalize consensus to 0-1 range, normalize recency (index/total) to 0-1 range, combine with weights
- [ ] 42. Write unit tests for distiller covering token budget enforcement, sort modes, and minimum consensus filtering
- [x] 43. Create `src/output/` directory structure
- [x] 44. Define `SessionGenerator` interface in `src/output/index.ts`
- [ ] 45. Implement Claude session generator in `src/output/claudeGenerator.ts` — emit JSONL with `compact_boundary` markers and `<system-reminder>` wrapped content
- [ ] 46. Implement Codex session generator in `src/output/codexGenerator.ts` — emit Codex-format JSONL with `type: "context"` events
- [ ] 47. Implement Gemini session generator in `src/output/geminiGenerator.ts` — emit Gemini-format JSON with `parts` array
- [ ] 48. Implement generator factory in `src/output/index.ts` — `getGenerator(platform)` returns correct generator
- [ ] 49. Write unit tests for Claude generator verifying `compact_boundary` format
- [ ] 50. Write unit tests for Codex generator verifying JSONL format
- [ ] 51. Write unit tests for Gemini generator verifying JSON format
- [ ] 52. Implement `DefensiveClaudeMemClient` in `src/memory/defensiveMem.ts`
- [ ] 53. Implement `storeObservation()` with write-local-first to `_sync_queue` table
- [ ] 54. Implement `flushSyncQueue()` to retry unsynced entries against ClaudeMem HTTP worker
- [ ] 55. Implement `getSyncQueueSize()` for status reporting
- [ ] 56. Write unit tests for defensive mem wrapper covering offline and online scenarios
- [x] 57. Create SQLite migration file `src/storage/distillMigrations.ts` with `chunks`, `assessments`, `external_sessions`, `chunk_fts`, and `_sync_queue` table creation
- [x] 58. Integrate migration into `SessionDb` constructor — call `runDistillMigrations()` after existing `ensureColumn` calls
- [x] 59. Write unit test for distill migrations — verify all 5 tables are created
- [x] 60. Add `importanceScore` optional column to `events` table via `ensureColumn` migration
- [x] 61. Add `chunkId` optional column to `events` table via `ensureColumn` migration
- [x] 62. Add `consensusScore` optional column to `events` table via `ensureColumn` migration
- [x] 63. Extend `CanonicalEventBase` in `src/session/types.ts` with `importanceScore`, `chunkId`, `assessmentScores`, `consensusScore`, `sourceSessionId`, `sourcePlatform`, `toolCalls` optional fields
- [ ] 64. Add distill command kinds to `Command` union type in `src/commands/parse.ts`
- [ ] 65. Implement `:distill` command parser in `parseLine()` — handle `scan`, `run`, `seed`, `query`, `report`, `assess`, `status`, `watch` subcommands
- [ ] 66. Write unit tests for `:distill` command parsing covering all 8 subcommands
- [ ] 67. Add `:distill scan` handler to `runCommand()` in `src/repl.ts` — call scanner, display results table
- [ ] 68. Add `:distill run` handler to `runCommand()` — execute full pipeline: scan → parse → score → chunk → assess → consensus → distill
- [ ] 69. Add `:distill seed` handler to `runCommand()` — generate platform-specific session file from most recent distillation
- [ ] 70. Add `:distill query` handler to `runCommand()` — search `chunk_fts` table for matching chunks
- [ ] 71. Add `:distill report` handler to `runCommand()` — show session statistics (event count, chunk count, avg score, top chunks)
- [ ] 72. Add `:distill assess` handler to `runCommand()` — trigger multi-agent assessment on specific chunk
- [ ] 73. Add `:distill status` handler to `runCommand()` — show pipeline state (sync queue size, in-progress assessments, last run)
- [ ] 74. Add `:distill watch` handler to `runCommand()` — toggle background file watcher
- [ ] 75. Implement background file watcher using `Bun.file().watch()` or polling interval on session directories
- [ ] 76. Implement backpressure-aware assessment queue — don't spawn new assessments if more than `maxConcurrent` are in flight
- [ ] 77. Add distillation counters to `GatewayMetrics` — `distill_scans_total`, `distill_runs_total`, `distill_chunks_assessed`, `distill_sessions_generated`
- [ ] 78. Add `:distill` to `:help` output in REPL
- [ ] 79. Update `README.md` with distillation commands documentation
- [ ] 80. Update `TODO.md` with distillation feature status
- [ ] 81. Add `bun run smoke:distill` script to `package.json` for distillation smoke test
- [ ] 82. Implement distillation smoke test in `scripts/smoke-distill.ts` — scan → parse → score → chunk → verify pipeline runs end-to-end with mock data
- [ ] 83. Add integration test: ingest a real Claude JSONL session, run full pipeline, verify output file is valid Claude-format JSONL
- [ ] 84. Add integration test: ingest a real Codex JSONL session, run full pipeline, verify output file is valid Codex-format JSONL
- [ ] 85. Add integration test: ingest a real Gemini JSON session, run full pipeline, verify output file is valid Gemini-format JSON
- [ ] 86. Add integration test: cross-platform — ingest Claude session, generate Gemini output, verify format
- [ ] 87. Add integration test: real-time scoring — send 10 events through wrapped SessionManager, verify all have `importanceScore` attached
- [ ] 88. Add integration test: defensive mem — store 5 observations with ClaudeMem offline, verify sync queue has 5 entries, flush after online, verify queue is empty
- [ ] 89. Add integration test: background watcher — create a test session file, verify watcher detects it and triggers scoring
- [ ] 90. Wire real-time scoring into `runRepl()` — wrap SessionManager before entering REPL loop
- [ ] 91. Wire defensive mem into `runRepl()` — replace direct ClaudeMemClient with DefensiveClaudeMemClient
- [ ] 92. Add periodic sync queue flush to REPL event loop (every 60 seconds)
- [ ] 93. Add graceful shutdown for background watcher and sync queue on `:quit`
- [ ] 94. Define `QueryDistillConfig` and `QueryDistillResult` interfaces in `src/distiller/queryDistiller.ts`
- [ ] 95. Implement FTS-based chunk search in `queryDistill()` — query `chunk_fts` table with user's question, return matching chunk IDs with their associated chunks
- [ ] 96. Implement ClaudeMem-based chunk search in `queryDistill()` — call `memClient.searchAsChunks(question)` to discover relevant past observations as synthetic chunks
- [ ] 97. Implement candidate pool merge and deduplication in `queryDistill()` — combine FTS results and ClaudeMem results, deduplicate by content hash
- [ ] 98. Implement question-aware re-ranking in `queryDistill()` — send merged candidates through question-aware assessment prompts via provider CLIs
- [ ] 99. Implement question-weighted consensus scoring — `queryWeight * questionRelevance + staticWeight * generalConsensus` with configurable weights (default 0.6/0.4)
- [ ] 100. Implement token-budget selection within `queryDistill()` using question-weighted scores to produce a `QueryDistillResult`
- [ ] 101. Write unit tests for `queryDistill()` covering FTS search, ClaudeMem search, merge/dedup, and question-weighted scoring
- [ ] 102. Define `ClaudeMemSearchResult` interface in `src/memory/defensiveMem.ts`
- [ ] 103. Implement `searchAsChunks()` method on `DefensiveClaudeMemClient` — convert ClaudeMem search results to synthetic Chunk objects with similarity-derived importance scores
- [ ] 104. Write unit tests for `searchAsChunks()` covering result conversion, empty results, and missing metadata fields
- [ ] 105. Implement `buildQuestionAwarePrompt()` in `src/assessment/prompts.ts` — inject user's question, rate on questionRelevance/signalDensity/contextValue, request JSON response
- [ ] 106. Write unit tests for question-aware prompt template verifying question injection and JSON response schema expectations
- [ ] 107. Add `distill_ask` command kind to `Command` union type in `src/commands/parse.ts`
- [ ] 108. Implement `:distill ask` command parser in `parseLine()` — parse quoted question string, optional `--platform` and `--providers` flags
- [ ] 109. Add `:distill ask` handler to `runCommand()` in `src/repl.ts` — call `queryDistill()`, generate platform-specific session file, display summary with file path and usage instructions
- [ ] 110. Write unit test for `:distill ask` command parsing with various argument combinations
- [ ] 111. Add integration test: `:distill ask` end-to-end — ask a question against pre-populated chunks, verify output file contains question-relevant content ranked by relevance
- [ ] 112. Update `:help` output to include `:distill ask` command documentation

---

## 8. Dependency Graph (Critical Path)

```
Types (items 2-3) ──→ Parsers (4-7) ──→ Scanner (14) ──→ Pipeline Integration (68)
                                                              ↑
Scoring (17-19) ──→ Realtime Hook (21) ──→ Chunker (24) ──→──┘
                                               ↓
                                          Assessor (30-31) ──→ Consensus (36)
                                                                    ↓
                                                              Distiller (40)
                                                                    ↓
                                                              Generators (45-47)
                                                                    ↓
                                                              REPL Commands (67-74)
                                                                    ↓
                                                              Integration Tests (83-89)

SQLite Migrations (57-62) ──→ [Parallel with all above, needed before persist]
Defensive Mem (52-56) ──→ [Parallel with all above, needed before REPL wire-up]

Question-Driven Path (items 94-112):
QueryDistiller (94-101) depends on ──→ Distiller (40) + Defensive Mem (52-56) + Assessor (30-31)
                                              ↓
                               Question-Aware Prompts (105-106) depends on ──→ Prompts (29)
                                              ↓
                               ClaudeMem Input (102-104) depends on ──→ Defensive Mem (52-56)
                                              ↓
                               :distill ask (107-109) depends on ──→ QueryDistiller + Generators
                                              ↓
                               Integration Tests (110-111) depends on ──→ :distill ask handler
```

**Critical path**: Types → Parsers → Scoring → Chunker → Assessor → Consensus → Distiller → Generators → REPL Integration → Tests

**Question-driven critical path**: Distiller + DefensiveMem + Assessor → QueryDistiller → Question-Aware Prompts → `:distill ask` → Integration Tests

**Parallelizable**:
- Parsers (Claude/Codex/Gemini) can be built simultaneously
- Generators (Claude/Codex/Gemini) can be built simultaneously
- SQLite migrations can be built in parallel with parsers/scoring
- Defensive mem can be built in parallel with assessment/distillation
- Unit tests can be written alongside their implementation

---

## 9. Implementation Phases (Recommended Order)

### Phase 1: Foundation (Items 1-3, 12-13, 16-17, 27, 38, 43, 57-63)
Create all directory structures, define all interfaces and types, run SQLite migrations. No logic yet — pure scaffolding. Enables all parallel work streams.

### Phase 2: Parsers (Items 4-11, 14-15)
Build all three platform parsers, auto-detection, scanner, and their tests. Self-contained — can be validated independently.

### Phase 3: Scoring + Chunking (Items 18-26)
Build importance scorer, real-time hook, and chunk builder with tests. These are pure functions with no external dependencies.

### Phase 4: Assessment (Items 28-37)
Build multi-agent assessor, prompts, and consensus scorer. Requires providers to be running (use mock for tests).

### Phase 5: Distillation + Output (Items 39-51)
Build token-budget distiller and all three platform generators. Depends on scoring and assessment outputs.

### Phase 6: Memory + Storage (Items 52-56, 60-62)
Build defensive ClaudeMem wrapper and remaining storage migrations. Parallel with Phase 5.

### Phase 7: REPL Integration (Items 64-78, 90-93)
Wire everything into the REPL command system. Depends on all prior phases.

### Phase 8: Documentation + Testing (Items 79-89)
Update docs, write integration tests, add smoke test script. Final validation.

### Phase 9: Question-Driven Features (Items 94-112)
Build the question-driven distillation pipeline: `queryDistill()` with FTS + ClaudeMem dual search, question-aware assessment prompts, `searchAsChunks()` on DefensiveClaudeMemClient, `:distill ask` command handler, and end-to-end integration tests. Depends on Phases 4-6 (assessment, distillation, memory) being complete. This phase fulfills the original project goal of creating fresh sessions based on a specific user question.

---

## 10. Configuration & Environment Variables

New environment variables (all optional):

| Variable | Default | Purpose |
|---|---|---|
| `UNIFIED_AGENT_DISTILL_ENABLED` | `0` | Enable real-time scoring on session events |
| `UNIFIED_AGENT_DISTILL_WATCH` | `0` | Enable background file watcher at startup |
| `UNIFIED_AGENT_DISTILL_PROVIDERS` | `claude,codex,gemini` | Which providers to use for assessment |
| `UNIFIED_AGENT_DISTILL_TOKEN_BUDGET` | `80000` | Max tokens in distilled output |
| `UNIFIED_AGENT_DISTILL_MIN_CONSENSUS` | `5.0` | Minimum consensus score to include chunk |
| `UNIFIED_AGENT_DISTILL_ASSESSMENT_TIMEOUT_MS` | `30000` | Per-assessment timeout |
| `UNIFIED_AGENT_DISTILL_MAX_CONCURRENT` | `3` | Max parallel assessments |
| `UNIFIED_AGENT_DISTILL_SYNC_INTERVAL_MS` | `60000` | ClaudeMem sync queue flush interval |
| `UNIFIED_AGENT_DISTILL_SORT_MODE` | `hybrid` | Sort mode: consensus, chronological, hybrid |
| `UNIFIED_AGENT_DISTILL_QUERY_WEIGHT` | `0.6` | Weight for question-relevance in query-driven mode |
| `UNIFIED_AGENT_DISTILL_STATIC_WEIGHT` | `0.4` | Weight for general importance in query-driven mode |
| `UNIFIED_AGENT_DISTILL_CLAUDEMEM_MAX` | `20` | Max ClaudeMem search results for query-driven mode |
| `UNIFIED_AGENT_DISTILL_RERANK` | `1` | Enable question-aware re-ranking (0 to disable) |

---

## 11. Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Provider CLI not installed | Medium | Assessment skipped for that provider | Graceful fallback: assess with available providers only, warn user |
| ClaudeMem worker offline | High | Observations not synced | Defensive wrapper with `_sync_queue` — local-first, sync later |
| Large session files (>100MB) | Low | Memory pressure during parsing | Streaming parsers using `AsyncGenerator` — never load full file |
| Assessment costs (API tokens) | Medium | Unexpected spend | Token tracking per assessment, configurable budget cap, use cheapest models |
| Platform format changes | Low | Parser breakage | Version detection in parsers, graceful unknown-field handling |
| SQLite WAL contention | Low | Write failures during parallel assessment | Single writer pattern — queue writes through SessionDb |

---

## 12. Success Criteria

1. `:distill scan` discovers sessions across all three platforms in < 2 seconds
2. `:distill run` completes full pipeline on a 500-event session in < 60 seconds
3. `:distill seed claude` generates a valid JSONL file that Claude Code can load
4. `:distill seed codex` generates a valid JSONL file that Codex CLI can load
5. `:distill seed gemini` generates a valid JSON file that Gemini CLI can load
6. Real-time scoring adds < 1ms latency per event to `recordEvent()`
7. Defensive mem wrapper survives ClaudeMem downtime without data loss
8. All unit tests pass (`bun test`)
9. Smoke test passes (`bun run smoke:distill`)
10. Background watcher detects new sessions within 5 seconds
11. **Video Cutoff Root Cause** — `:distill ask "What caused the video cutoff on the podcast page?"` against session `27cc6573` must produce output containing: (a) `h-[110vh]` or equivalent fixed viewport height reference, (b) `overflow-hidden` as the clipping mechanism, (c) the 16:9 aspect ratio interaction. **Pass:** output references all three elements. **Fail:** any of the three missing.
12. **Three-State Video Pattern** — `:distill ask "How does the Testimonial video interaction work?"` against session `83e93084` must produce output containing: (a) `isActivelyWatching` state variable name, (b) the three states (muted / playing / paused), (c) 15% opacity overlay behavior, (d) `VideoQuoteCard` as the inherited pattern. **Pass:** output references (a) + at least two of (b/c/d). **Fail:** `isActivelyWatching` missing or fewer than two supporting details.
13. **File Structure & Paths** — `:distill ask "What files changed for the podcast video player?"` against session `27cc6573` must produce output containing: (a) `PodcastVideoPlayer/index.tsx` as a created file, (b) `EpisodeHero` and `PodcastHero` as modified files, (c) the Payload CMS convention that blocks use `config.ts` + `Component.tsx` while components use `index.tsx`. **Pass:** output contains (a) + (b). **Fail:** neither created nor modified files identified.
14. **Dev Environment Gotchas** — `:distill ask "What do I need to run after changing a Payload CMS block config?"` against sessions `27cc6573` + `83e93084` must produce output containing: (a) `pnpm generate:types` as a required step, (b) the dev server restart pattern. **Pass:** output contains `generate:types` command. **Fail:** command absent from output.

---

## 13. File Manifest (New Files)

```
src/
├── parsers/
│   ├── types.ts                    # ParsedEvent, SessionParser interfaces
│   ├── index.ts                    # Auto-detection, factory
│   ├── claudeParser.ts             # Claude Code JSONL parser
│   ├── codexParser.ts              # Codex CLI JSONL parser
│   └── geminiParser.ts             # Gemini CLI JSON parser
├── scanner/
│   ├── paths.ts                    # PLATFORM_SESSION_PATHS, ScannedSession
│   └── scanner.ts                  # File discovery and sorting
├── scoring/
│   ├── importance.ts               # scoreEvent(), ScoringConfig
│   ├── realtime.ts                 # wrapSessionManagerWithScoring()
│   └── chunker.ts                  # buildChunks(), Chunk, ChunkConfig
├── assessment/
│   ├── assessor.ts                 # assessChunk(), assessChunks()
│   ├── prompts.ts                  # Assessment prompt templates
│   └── consensus.ts                # computeConsensus()
├── distiller/
│   ├── distiller.ts                # distill(), DistilledSession
│   └── queryDistiller.ts           # queryDistill(), QueryDistillResult (question-driven)
├── output/
│   ├── index.ts                    # SessionGenerator, getGenerator()
│   ├── claudeGenerator.ts          # Claude JSONL with compact_boundary
│   ├── codexGenerator.ts           # Codex JSONL format
│   └── geminiGenerator.ts          # Gemini JSON format
├── memory/
│   └── defensiveMem.ts             # DefensiveClaudeMemClient
└── storage/
    └── distillMigrations.ts        # New SQLite tables

scripts/
└── smoke-distill.ts                # Distillation smoke test

Modified files:
├── src/session/types.ts            # Extended CanonicalEventBase
├── src/storage/sqlite.ts           # Migration integration
├── src/commands/parse.ts           # :distill command parsing (incl. :distill ask)
├── src/repl.ts                     # :distill handlers (incl. ask), realtime hook, defensive mem
├── src/assessment/prompts.ts       # Question-aware prompt template added
├── package.json                    # smoke:distill script
├── README.md                       # Distillation docs
└── TODO.md                         # Feature status
```

**Total new files**: 20
**Total modified files**: 8
**Estimated new lines**: ~1,650 TypeScript
