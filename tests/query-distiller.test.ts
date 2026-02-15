import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  searchChunksFts,
  mergeCandidates,
  computeQuestionWeightedScore,
  queryDistill,
} from "../src/distiller/queryDistiller.ts";
import { runDistillMigrations } from "../src/storage/distillMigrations.ts";
import { ClaudeMemClient } from "../src/memory/claudeMemClient.ts";
import { DefensiveClaudeMemClient } from "../src/memory/defensiveMem.ts";
import type { Chunk } from "../src/scoring/chunker.ts";
import type { ParsedEvent } from "../src/parsers/types.ts";

function makeEvent(overrides: Partial<ParsedEvent> = {}): ParsedEvent {
  return {
    type: "assistant",
    role: "assistant",
    content: "Hello world",
    ...overrides,
  };
}

function makeChunk(overrides: Partial<Chunk> = {}): Chunk {
  return {
    id: "chunk_001",
    sessionId: "session_001",
    events: [makeEvent()],
    startIndex: 0,
    endIndex: 0,
    importanceAvg: 50,
    tokenEstimate: 100,
    ...overrides,
  };
}

/** Create a test DB with distill migrations applied. */
function createTestDb(dir: string): Database {
  const db = new Database(join(dir, "test.sqlite"));
  db.run("PRAGMA journal_mode = WAL;");
  // Create meta_sessions table (needed for foreign keys)
  db.run(`
    CREATE TABLE IF NOT EXISTS meta_sessions (
      id TEXT PRIMARY KEY,
      provider TEXT,
      model TEXT,
      project TEXT,
      cwd TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
  db.run(`INSERT INTO meta_sessions (id, provider, project, cwd) VALUES ('test_session', 'mock', 'test', '/tmp')`);
  runDistillMigrations(db);
  return db;
}

/** Create a mock ClaudeMemClient that returns controlled results. */
function createMockClient(fetchFn: typeof fetch): ClaudeMemClient {
  return new ClaudeMemClient("http://mock-claudemem:37777", fetchFn);
}

/** Create a DefensiveClaudeMemClient with offline ClaudeMem. */
function createOfflineDefensiveMem(db: Database): DefensiveClaudeMemClient {
  const inner = createMockClient(async () => {
    throw new Error("connection refused");
  });
  return new DefensiveClaudeMemClient(inner, db);
}

/** Insert a chunk into the database with FTS entry. */
function insertChunkWithFts(
  db: Database,
  chunkId: string,
  content: string,
  consensus: number = 7.0,
  importance: number = 60,
): void {
  db.run(
    `INSERT INTO chunks (id, meta_session_id, chunk_index, start_event_index, end_event_index, importance_avg, consensus_score, token_count, summary)
     VALUES (?, 'test_session', 0, 0, 0, ?, ?, ?, ?)`,
    [chunkId, importance, consensus, Math.ceil(content.length / 4), content.slice(0, 200)],
  );
  db.run(
    `INSERT INTO chunk_fts (chunk_id, content) VALUES (?, ?)`,
    [chunkId, content],
  );
}

describe("searchChunksFts", () => {
  let dir: string;
  let db: Database;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "query-distiller-test-"));
    db = createTestDb(dir);
  });

  afterEach(() => {
    db.close();
  });

  test("returns matching chunks from FTS search", () => {
    insertChunkWithFts(db, "chunk_a", "The adapter pattern normalizes provider events into a canonical format");
    insertChunkWithFts(db, "chunk_b", "The login page uses OAuth for authentication");
    insertChunkWithFts(db, "chunk_c", "Adapters handle codex gemini and claude formats");

    const results = searchChunksFts(db, "adapter pattern");
    expect(results.length).toBeGreaterThanOrEqual(1);

    const chunkIds = results.map((r) => r.chunk.id);
    expect(chunkIds).toContain("chunk_a");
  });

  test("returns empty array when no matches", () => {
    insertChunkWithFts(db, "chunk_a", "The login page uses OAuth for authentication");

    const results = searchChunksFts(db, "database migration schema");
    expect(results).toEqual([]);
  });

  test("returns empty array for very short query terms", () => {
    insertChunkWithFts(db, "chunk_a", "Some content here");
    const results = searchChunksFts(db, "a b");
    expect(results).toEqual([]);
  });

  test("loads consensus score from chunks table", () => {
    insertChunkWithFts(db, "chunk_a", "The adapter pattern is important", 8.5);
    const results = searchChunksFts(db, "adapter pattern");
    expect(results.length).toBe(1);
    expect(results[0].existingConsensus).toBe(8.5);
  });

  test("handles special characters in question", () => {
    insertChunkWithFts(db, "chunk_a", "Function getValue returns number type");
    const results = searchChunksFts(db, "getValue() returns what?");
    // Should not throw — special chars are stripped
    expect(Array.isArray(results)).toBe(true);
  });
});

describe("mergeCandidates", () => {
  test("merges FTS and ClaudeMem candidates without duplicates", () => {
    const fts = [
      {
        chunk: makeChunk({ id: "a" }),
        source: "fts" as const,
        existingConsensus: 7,
        questionScore: 0,
        contentHash: "hash_1",
      },
    ];
    const mem = [
      {
        chunk: makeChunk({ id: "b" }),
        source: "claudemem" as const,
        existingConsensus: 6,
        questionScore: 0,
        contentHash: "hash_2",
      },
    ];

    const merged = mergeCandidates(fts, mem);
    expect(merged.length).toBe(2);
  });

  test("keeps higher-scoring duplicate when content hashes match", () => {
    const fts = [
      {
        chunk: makeChunk({ id: "a" }),
        source: "fts" as const,
        existingConsensus: 5,
        questionScore: 0,
        contentHash: "same_hash",
      },
    ];
    const mem = [
      {
        chunk: makeChunk({ id: "b" }),
        source: "claudemem" as const,
        existingConsensus: 8,
        questionScore: 0,
        contentHash: "same_hash",
      },
    ];

    const merged = mergeCandidates(fts, mem);
    expect(merged.length).toBe(1);
    expect(merged[0].existingConsensus).toBe(8);
  });

  test("handles empty FTS results", () => {
    const mem = [
      {
        chunk: makeChunk({ id: "b" }),
        source: "claudemem" as const,
        existingConsensus: 6,
        questionScore: 0,
        contentHash: "hash_2",
      },
    ];

    const merged = mergeCandidates([], mem);
    expect(merged.length).toBe(1);
  });

  test("handles empty ClaudeMem results", () => {
    const fts = [
      {
        chunk: makeChunk({ id: "a" }),
        source: "fts" as const,
        existingConsensus: 7,
        questionScore: 0,
        contentHash: "hash_1",
      },
    ];

    const merged = mergeCandidates(fts, []);
    expect(merged.length).toBe(1);
  });

  test("handles both empty", () => {
    const merged = mergeCandidates([], []);
    expect(merged.length).toBe(0);
  });
});

describe("computeQuestionWeightedScore", () => {
  test("weights question score at 60% and consensus at 40% by default", () => {
    const candidate = {
      chunk: makeChunk(),
      source: "fts" as const,
      existingConsensus: 10, // Max consensus
      questionScore: 10, // Max question score
      contentHash: "hash",
    };

    const score = computeQuestionWeightedScore(candidate);
    // normalizedQuestion = (10-1)/9 = 1.0
    // normalizedConsensus = 10/10 = 1.0
    // final = 0.6 * 1.0 + 0.4 * 1.0 = 1.0
    expect(score).toBeCloseTo(1.0, 2);
  });

  test("scores zero when both question and consensus are minimum", () => {
    const candidate = {
      chunk: makeChunk(),
      source: "fts" as const,
      existingConsensus: 0,
      questionScore: 1,
      contentHash: "hash",
    };

    const score = computeQuestionWeightedScore(candidate);
    // normalizedQuestion = (1-1)/9 = 0
    // normalizedConsensus = 0/10 = 0
    expect(score).toBeCloseTo(0, 2);
  });

  test("respects custom weights", () => {
    const candidate = {
      chunk: makeChunk(),
      source: "fts" as const,
      existingConsensus: 5,
      questionScore: 10,
      contentHash: "hash",
    };

    // 100% question weight
    const fullQuestion = computeQuestionWeightedScore(candidate, 1.0, 0.0);
    // normalizedQuestion = (10-1)/9 = 1.0
    expect(fullQuestion).toBeCloseTo(1.0, 2);

    // 100% consensus weight
    const fullConsensus = computeQuestionWeightedScore(candidate, 0.0, 1.0);
    // normalizedConsensus = 5/10 = 0.5
    expect(fullConsensus).toBeCloseTo(0.5, 2);
  });

  test("handles mid-range values correctly", () => {
    const candidate = {
      chunk: makeChunk(),
      source: "fts" as const,
      existingConsensus: 5,
      questionScore: 5.5,
      contentHash: "hash",
    };

    const score = computeQuestionWeightedScore(candidate);
    // normalizedQuestion = (5.5-1)/9 = 0.5
    // normalizedConsensus = 5/10 = 0.5
    // final = 0.6 * 0.5 + 0.4 * 0.5 = 0.5
    expect(score).toBeCloseTo(0.5, 2);
  });
});

describe("queryDistill (integration with mocked dependencies)", () => {
  let dir: string;
  let db: Database;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "query-distill-int-"));
    db = createTestDb(dir);
  });

  afterEach(() => {
    db.close();
  });

  test("returns empty chunks when nothing matches", async () => {
    const memClient = createOfflineDefensiveMem(db);

    const result = await queryDistill("nonexistent topic xyz", db, memClient, {
      reRankWithQuestion: false, // Skip actual CLI calls
    });

    expect(result.chunks.length).toBe(0);
    expect(result.question).toBe("nonexistent topic xyz");
    expect(result.searchStats.chunkFtsMatches).toBe(0);
  });

  test("finds FTS matches and returns them without re-ranking", async () => {
    insertChunkWithFts(db, "chunk_adapter", "The adapter pattern normalizes provider events", 7.0);
    insertChunkWithFts(db, "chunk_login", "Login page uses OAuth authentication", 6.0);

    const memClient = createOfflineDefensiveMem(db);

    const result = await queryDistill("adapter pattern", db, memClient, {
      reRankWithQuestion: false, // Skip actual CLI calls
      searchSources: "chunks",
    });

    expect(result.searchStats.chunkFtsMatches).toBeGreaterThanOrEqual(1);
    expect(result.chunks.length).toBeGreaterThanOrEqual(1);
    expect(result.question).toBe("adapter pattern");
  });

  test("respects token budget", async () => {
    // Insert many chunks
    for (let i = 0; i < 10; i++) {
      const content = `Chunk ${i} about adapters with lots of content `.repeat(100);
      insertChunkWithFts(db, `chunk_${i}`, content, 7.0 + i * 0.1);
    }

    const memClient = createOfflineDefensiveMem(db);

    const result = await queryDistill("adapters", db, memClient, {
      reRankWithQuestion: false,
      searchSources: "chunks",
      maxTokens: 500, // Very small budget
    });

    expect(result.totalTokens).toBeLessThanOrEqual(500);
    expect(result.droppedChunks).toBeGreaterThan(0);
  });

  test("populates searchStats correctly", async () => {
    insertChunkWithFts(db, "chunk_a", "Testing the search statistics feature");

    const memClient = createOfflineDefensiveMem(db);

    const result = await queryDistill("search statistics", db, memClient, {
      reRankWithQuestion: false,
      searchSources: "both",
    });

    expect(result.searchStats).toBeDefined();
    expect(typeof result.searchStats.chunkFtsMatches).toBe("number");
    expect(typeof result.searchStats.claudeMemMatches).toBe("number");
    expect(typeof result.searchStats.totalCandidates).toBe("number");
    expect(typeof result.searchStats.afterReRank).toBe("number");
  });

  test("includes distilledAt timestamp", async () => {
    const memClient = createOfflineDefensiveMem(db);

    const result = await queryDistill("anything", db, memClient, {
      reRankWithQuestion: false,
    });

    expect(result.distilledAt).toBeTruthy();
    // Should be a valid ISO string
    expect(new Date(result.distilledAt).toISOString()).toBe(result.distilledAt);
  });

  test("uses only FTS when searchSources is 'chunks'", async () => {
    insertChunkWithFts(db, "chunk_a", "Testing chunk-only search mode");

    const memClient = createOfflineDefensiveMem(db);

    const result = await queryDistill("chunk search", db, memClient, {
      reRankWithQuestion: false,
      searchSources: "chunks",
    });

    expect(result.searchStats.claudeMemMatches).toBe(0);
  });

  test("uses only ClaudeMem when searchSources is 'claudemem'", async () => {
    insertChunkWithFts(db, "chunk_a", "This should not appear in claudemem-only mode");

    const memClient = createOfflineDefensiveMem(db);

    const result = await queryDistill("test query", db, memClient, {
      reRankWithQuestion: false,
      searchSources: "claudemem",
    });

    expect(result.searchStats.chunkFtsMatches).toBe(0);
  });
});
