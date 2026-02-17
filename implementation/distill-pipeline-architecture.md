# Distill Pipeline Architecture

## Full Pipeline Overview

```mermaid
flowchart TB
    subgraph INPUT["1. Input"]
        NL["':distill filter' or ':distill build'"]
        SESSIONS["Session Files<br/>~/.claude/projects/**/*.jsonl<br/>~/.codex/**/*.jsonl<br/>~/.gemini/**/*.json"]
    end

    subgraph SCAN["2. Scan & Parse"]
        SCANNER["Scanner<br/>projectPath filter<br/>since/until dates<br/>limit N sessions"]
        PARSER["Parser<br/>detectParser() per file<br/>Claude / Codex / Gemini format"]
        EVENTS["ParsedEvent[]<br/>role, content, toolName,<br/>toolInput, toolOutput, timestamp"]
    end

    subgraph SCORE["3. Score & Chunk"]
        IMPORTANCE["Importance Scorer<br/>Base: 50<br/>+15 tool use<br/>+20 error<br/>+12 file edit<br/>+10 user prompt<br/>-20 system event"]
        FILTER_LOW["Filter: score >= 30"]
        CHUNKER["Chunker<br/>Window: 20 events max<br/>Budget: 4000 tokens/chunk<br/>Overlap: 2 events"]
        KW_FILTER["Keyword Filter<br/>(if NL keywords extracted)"]
    end

    subgraph ASSESS["4. Multi-Agent Assessment"]
        SPAWN["Spawn Provider CLIs<br/>codex exec / claude -p / gemini"]
        SCORE_110["Each provider scores 1-10<br/>+ rationale text<br/>30s timeout, 1 retry"]
        CONSENSUS["Consensus<br/>Weighted avg<br/>Outlier removal (2 stddev)<br/>minAssessments check"]
    end

    subgraph DISTILL["5. Distill & Select"]
        FILTER_CONS["Filter: consensus >= 5.0"]
        SORT["Hybrid Sort<br/>70% consensus + 30% recency"]
        BUDGET["Greedy Token Budget<br/>Pick top chunks until 80K tokens"]
        REORDER["Re-sort chronologically<br/>for narrative coherence"]
    end

    subgraph SYNTHESIZE["6. Synthesize & Generate"]
        CLASSIFY["Topic Classifier<br/>9 topics via keyword matching"]
        DEDUP["Deduplication<br/>Jaccard >= 0.6 removes duplicates"]
        CONTRADICT["Contradiction Resolution<br/>Latest timestamp wins"]
        NARRATIVE["Narrative Assembly<br/>overview -> architecture -> patterns<br/>-> dependencies -> deployment<br/>-> decisions -> recent-changes -> known-issues"]
        JSONL["JSONL Generator<br/>Claude Code format<br/>uuid chain, timestamps,<br/>user/assistant turns"]
    end

    subgraph LOAD["7. Load & Use"]
        LOAD_CMD["':distill load'"]
        STATE["REPL State<br/>loadedConversation"]
        CLAUDE_RESUME["Claude: --resume flag<br/>(native conversation history)"]
        OTHER_CTX["Codex/Gemini: text prepend<br/>(DISTILLED PROJECT CONTEXT block)"]
    end

    NL --> SCANNER
    SESSIONS --> SCANNER
    SCANNER --> PARSER
    PARSER --> EVENTS
    EVENTS --> IMPORTANCE
    IMPORTANCE --> FILTER_LOW
    FILTER_LOW --> CHUNKER
    CHUNKER --> KW_FILTER
    KW_FILTER --> SPAWN
    SPAWN --> SCORE_110
    SCORE_110 --> CONSENSUS
    CONSENSUS --> FILTER_CONS
    FILTER_CONS --> SORT
    SORT --> BUDGET
    BUDGET --> REORDER
    REORDER --> CLASSIFY
    CLASSIFY --> DEDUP
    DEDUP --> CONTRADICT
    CONTRADICT --> NARRATIVE
    NARRATIVE --> JSONL
    JSONL --> LOAD_CMD
    LOAD_CMD --> STATE
    STATE --> CLAUDE_RESUME
    STATE --> OTHER_CTX
```

## Assessment Deep Dive

This is the quality gate. Each chunk is independently evaluated by one or more AI providers.

```mermaid
flowchart LR
    CHUNK["Chunk<br/>~20 events<br/>~4000 tokens"]

    subgraph PROVIDERS["Provider Assessment (parallel)"]
        direction TB
        CODEX["codex exec<br/>'Score 1-10...'<br/>30s timeout"]
        CLAUDE["claude -p<br/>'Score 1-10...'<br/>30s timeout"]
        GEMINI["gemini<br/>'Score 1-10...'<br/>30s timeout"]
    end

    subgraph RESULTS["Per-Chunk Results"]
        R1["codex: 8/10<br/>'Contains deployment config<br/>and error resolution'"]
        R2["claude: 7/10<br/>'Useful debugging patterns<br/>but some noise'"]
        R3["gemini: 9/10<br/>'Critical deployment<br/>decision documented'"]
    end

    subgraph CONSENSUS_CALC["Consensus Calculation"]
        OUTLIER["Outlier Check<br/>|score - mean| > 2*stddev?<br/>If yes, remove"]
        WAVG["Weighted Average<br/>(8*1.0 + 7*1.0 + 9*1.0) / 3<br/>= 8.0"]
        GATE["Gate: >= 5.0?<br/>YES -> keep<br/>NO -> drop"]
    end

    CHUNK --> CODEX
    CHUNK --> CLAUDE
    CHUNK --> GEMINI
    CODEX --> R1
    CLAUDE --> R2
    GEMINI --> R3
    R1 --> OUTLIER
    R2 --> OUTLIER
    R3 --> OUTLIER
    OUTLIER --> WAVG
    WAVG --> GATE
```

### Single Provider Mode (--providers codex)

When only one provider is specified, `minAssessments` is set to 1 (not the default 2), so chunks aren't dropped for having too few assessments:

```mermaid
flowchart LR
    CHUNK["47 Chunks"]
    CODEX["codex exec<br/>Scores each 1-10"]
    SCORES["e.g., scores: 8, 7, 3, 9, 6, 2, 8..."]
    CONSENSUS["Consensus = raw score<br/>(no averaging needed)"]
    GATE["Gate: >= 5.0"]
    SELECTED["26 chunks pass"]
    DROPPED["21 chunks dropped<br/>(score < 5 or over budget)"]

    CHUNK --> CODEX --> SCORES --> CONSENSUS --> GATE
    GATE -->|pass| SELECTED
    GATE -->|fail| DROPPED
```

## Token Budget Selection

```mermaid
flowchart TB
    INPUT["26 chunks that passed consensus >= 5.0"]

    subgraph HYBRID["Hybrid Scoring"]
        NORM_C["Normalize consensus<br/>scores to 0-1"]
        NORM_R["Normalize recency<br/>(chronological index) to 0-1"]
        BLEND["Hybrid = 0.7 * consensus<br/>+ 0.3 * recency"]
        SORT_H["Sort by hybrid score<br/>descending"]
    end

    subgraph GREEDY["Greedy Selection"]
        PICK["Pick top chunk<br/>Add tokens to running total"]
        CHECK{"total <= 80,000?"}
        NEXT["Next chunk"]
        DONE["Selection complete"]
    end

    CHRONOLOGICAL["Re-sort selected chunks<br/>chronologically for output"]

    INPUT --> NORM_C
    INPUT --> NORM_R
    NORM_C --> BLEND
    NORM_R --> BLEND
    BLEND --> SORT_H
    SORT_H --> PICK
    PICK --> CHECK
    CHECK -->|yes| NEXT --> PICK
    CHECK -->|no| DONE
    DONE --> CHRONOLOGICAL
```

## Topic Synthesis Flow

```mermaid
flowchart TB
    CHUNKS["26 selected chunks"]

    subgraph CLASSIFY["Topic Classification"]
        direction LR
        KW["Keyword scan per chunk:<br/>deploy/railway/docker -> deployment<br/>bug/fix/error -> known-issues<br/>test/spec -> patterns<br/>config/env -> dependencies"]
        ASSIGN["Assign highest-scoring topic"]
    end

    subgraph TOPICS["Topic Buckets"]
        T1["patterns (5 chunks)"]
        T2["dependencies (4 chunks)"]
        T3["deployment (8 chunks)"]
        T4["recent-changes (6 chunks)"]
        T5["known-issues (3 chunks)"]
    end

    subgraph QUALITY["Quality Passes"]
        DEDUP["Dedup: Jaccard >= 0.6<br/>removes near-duplicate chunks"]
        CONTRA["Contradictions:<br/>Latest timestamp wins"]
    end

    subgraph OUTPUT["Narrative Output"]
        ORDER["Fixed narrative order:<br/>1. patterns<br/>2. dependencies<br/>3. deployment<br/>4. recent-changes<br/>5. known-issues"]
        TURNS["Generate Q&A turns<br/>User: 'Tell me about deployment...'<br/>Assistant: (synthesized chunk content)"]
    end

    CHUNKS --> KW --> ASSIGN
    ASSIGN --> T1 & T2 & T3 & T4 & T5
    T1 & T2 & T3 & T4 & T5 --> DEDUP --> CONTRA
    CONTRA --> ORDER --> TURNS
```

## Context Loading & Injection

```mermaid
flowchart TB
    BUILD["':distill build' output<br/>~/.unified-agent/distilled/<br/>2026-02-16-22-59-17-build.jsonl"]

    LOAD["':distill load'<br/>Reads JSONL, parses turns"]

    STATE["REPL State<br/>loadedConversation = {<br/>  filePath, cwd, sessionId,<br/>  turns: 54, topicCount: 26,<br/>  totalChars: 71,611<br/>}"]

    PROMPT["Prompt: |ctx| indicator<br/>in REPL prompt line"]

    USER_MSG["User sends message<br/>to any provider"]

    subgraph DISPATCH["Provider Dispatch"]
        direction LR
        CLAUDE["Claude Provider<br/>claude -p --resume file.jsonl<br/>(native conversation loading)"]
        CODEX["Codex Provider<br/>Prompt prepended with<br/>=== DISTILLED PROJECT CONTEXT ===<br/>(full assistant content as text)"]
        GEMINI["Gemini Provider<br/>Same text prepend<br/>as Codex"]
    end

    RESPONSE["Provider response<br/>includes distilled project knowledge"]

    BUILD --> LOAD --> STATE
    STATE --> PROMPT
    USER_MSG --> DISPATCH
    STATE -.->|Claude| CLAUDE
    STATE -.->|Codex| CODEX
    STATE -.->|Gemini| GEMINI
    CLAUDE --> RESPONSE
    CODEX --> RESPONSE
    GEMINI --> RESPONSE
```

## Quality Gates Summary

| Gate | Stage | Threshold | Effect |
|------|-------|-----------|--------|
| Importance | Scoring | >= 30 | Drops system events, hooks, low-value content |
| Token budget | Chunking | <= 4000/chunk | Prevents oversized chunks |
| Keyword filter | Post-chunk | Contains keyword | Focuses on user-specified topics |
| Assessment | Multi-agent | 1-10 score per provider | Independent quality evaluation |
| Consensus | Aggregation | >= 5.0 weighted avg | Drops low-quality chunks |
| Outlier removal | Consensus | > 2 stddev | Removes rogue assessments |
| Token budget | Selection | <= 80,000 total | Fits within context window |
| Deduplication | Synthesis | Jaccard >= 0.6 | Removes near-duplicate content |
| Contradiction | Synthesis | Latest wins | Ensures current information |

## Numbers from Your Run

```
Input:  20 sessions, 2466 events
Scored: Events with importance >= 30 kept
Chunks: 143 built -> 47 after keyword "railway" filter
Assessed: 47 chunks by codex (single provider)
Consensus: minAssessments=1 (single provider mode)
Selected: 26 of 47 (consensus >= 5.0, within 78,708 token budget)
Dropped: 21 chunks (below threshold or over budget)
Topics: 5 (patterns, dependencies, deployment, recent-changes, known-issues)
Output: 54 turns, 71,611 chars of distilled context
```
