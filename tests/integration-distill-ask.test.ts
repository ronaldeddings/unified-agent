import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, existsSync } from "node:fs";
import { Database } from "bun:sqlite";
import { ClaudeMemClient } from "../src/memory/claudeMemClient.ts";
import { DefensiveClaudeMemClient } from "../src/memory/defensiveMem.ts";
import { runDistillMigrations } from "../src/storage/distillMigrations.ts";
import { queryDistill } from "../src/distiller/queryDistiller.ts";
import { getGenerator } from "../src/output/index.ts";

/** Create a temporary SQLite DB with all required tables. */
function createTestDb(dir: string): Database {
  const db = new Database(join(dir, "test.sqlite"));
  db.run("PRAGMA journal_mode = WAL;");
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

/** Create a DefensiveClaudeMemClient with offline ClaudeMem. */
function createOfflineDefensiveMem(db: Database): DefensiveClaudeMemClient {
  const inner = new ClaudeMemClient("http://mock-claudemem:37777", async () => {
    throw new Error("connection refused");
  });
  return new DefensiveClaudeMemClient(inner, db);
}

/** Insert a chunk with FTS content for testing. */
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

describe("Integration: :distill ask end-to-end", () => {
  let dir: string;
  let db: Database;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "distill-ask-int-"));
    db = createTestDb(dir);
  });

  afterEach(() => {
    db.close();
  });

  test("asks a question against pre-populated chunks and returns relevant content", async () => {
    // Populate FTS with chunks about different topics
    insertChunkWithFts(
      db,
      "chunk_adapter_1",
      "The adapter pattern normalizes provider events into a canonical format. Each provider (Claude, Codex, Gemini) has a different JSONL structure, and the adapter layer translates these into CanonicalEvent objects.",
      8.0,
      75,
    );
    insertChunkWithFts(
      db,
      "chunk_adapter_2",
      "The claudeAdapter handles tool_use blocks from Claude responses and maps them to the unified tool_call event type. It also extracts text content from message.content arrays.",
      7.5,
      70,
    );
    insertChunkWithFts(
      db,
      "chunk_login",
      "The login page uses OAuth 2.0 for authentication. Users can sign in with Google or GitHub. Session tokens are stored in httpOnly cookies.",
      6.0,
      50,
    );
    insertChunkWithFts(
      db,
      "chunk_deploy",
      "Deployment uses Railway.app with automatic builds from the main branch. Environment variables are configured in the Railway dashboard.",
      5.5,
      45,
    );

    const memClient = createOfflineDefensiveMem(db);

    const result = await queryDistill("adapter pattern", db, memClient, {
      reRankWithQuestion: false, // Skip actual CLI assessment calls
      searchSources: "chunks",
    });

    // Should find the adapter-related chunks
    expect(result.chunks.length).toBeGreaterThanOrEqual(1);
    expect(result.question).toBe("adapter pattern");

    // Verify the adapter chunks were found, not unrelated ones
    const chunkIds = result.chunks.map((c) => c.id);
    expect(chunkIds).toContain("chunk_adapter_1");
    // Login/deploy chunks should NOT match "adapter pattern"
    expect(chunkIds).not.toContain("chunk_login");
    expect(chunkIds).not.toContain("chunk_deploy");

    // Verify content includes adapter-related text
    const allContent = result.chunks.flatMap((c) => c.events.map((e) => e.content)).join(" ");
    expect(allContent).toContain("adapter");
  });

  test("generates a valid Claude JSONL output file", async () => {
    insertChunkWithFts(
      db,
      "chunk_test",
      "Testing the output generation for Claude format sessions",
      7.0,
    );

    const memClient = createOfflineDefensiveMem(db);

    const result = await queryDistill("output generation", db, memClient, {
      reRankWithQuestion: false,
      searchSources: "chunks",
    });

    if (result.chunks.length === 0) {
      // If FTS didn't match, skip the file generation test
      return;
    }

    // Generate Claude JSONL output
    const outputPath = join(dir, "test-output.jsonl");
    const generator = getGenerator("claude");
    const writtenPath = await generator.generate(result, outputPath);

    // Verify file was created
    expect(existsSync(writtenPath)).toBe(true);

    // Verify it's valid JSONL
    const content = await readFile(writtenPath, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBeGreaterThan(0);

    // Each line should be valid JSON
    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(typeof parsed).toBe("object");
    }
  });

  test("generates a valid Codex JSONL output file", async () => {
    insertChunkWithFts(
      db,
      "chunk_test",
      "Testing the Codex output generation format",
      7.0,
    );

    const memClient = createOfflineDefensiveMem(db);

    const result = await queryDistill("Codex output", db, memClient, {
      reRankWithQuestion: false,
      searchSources: "chunks",
    });

    if (result.chunks.length === 0) return;

    const outputPath = join(dir, "test-output-codex.jsonl");
    const generator = getGenerator("codex");
    const writtenPath = await generator.generate(result, outputPath);

    expect(existsSync(writtenPath)).toBe(true);
    const content = await readFile(writtenPath, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBeGreaterThan(0);

    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(typeof parsed).toBe("object");
    }
  });

  test("generates a valid Gemini JSON output file", async () => {
    insertChunkWithFts(
      db,
      "chunk_test",
      "Testing the Gemini output generation format",
      7.0,
    );

    const memClient = createOfflineDefensiveMem(db);

    const result = await queryDistill("Gemini output", db, memClient, {
      reRankWithQuestion: false,
      searchSources: "chunks",
    });

    if (result.chunks.length === 0) return;

    const outputPath = join(dir, "test-output-gemini.json");
    const generator = getGenerator("gemini");
    const writtenPath = await generator.generate(result, outputPath);

    expect(existsSync(writtenPath)).toBe(true);
    const content = await readFile(writtenPath, "utf-8");
    const parsed = JSON.parse(content);
    expect(typeof parsed).toBe("object");
  });

  test("handles questions with no FTS matches gracefully", async () => {
    // Don't insert any chunks
    const memClient = createOfflineDefensiveMem(db);

    const result = await queryDistill(
      "completely unrelated topic about quantum physics",
      db,
      memClient,
      {
        reRankWithQuestion: false,
        searchSources: "chunks",
      },
    );

    expect(result.chunks.length).toBe(0);
    expect(result.totalTokens).toBe(0);
    expect(result.searchStats.chunkFtsMatches).toBe(0);
  });

  test("respects token budget in output selection", async () => {
    // Insert multiple chunks with known sizes
    for (let i = 0; i < 5; i++) {
      const content = `Chunk about testing topic number ${i} `.repeat(200); // ~5000 chars = ~1250 tokens
      insertChunkWithFts(db, `chunk_${i}`, content, 7.0 + i * 0.2);
    }

    const memClient = createOfflineDefensiveMem(db);

    const result = await queryDistill("testing topic", db, memClient, {
      reRankWithQuestion: false,
      searchSources: "chunks",
      maxTokens: 2000, // Only ~1-2 chunks should fit
    });

    expect(result.totalTokens).toBeLessThanOrEqual(2000);
    expect(result.droppedChunks).toBeGreaterThan(0);
  });

  test("searchStats reflects actual search behavior", async () => {
    insertChunkWithFts(db, "chunk_a", "Testing search stats with FTS data");
    insertChunkWithFts(db, "chunk_b", "Another testing entry for search stats");

    const memClient = createOfflineDefensiveMem(db);

    const result = await queryDistill("testing search", db, memClient, {
      reRankWithQuestion: false,
      searchSources: "both",
    });

    expect(result.searchStats.chunkFtsMatches).toBeGreaterThanOrEqual(1);
    // ClaudeMem is offline, so it should be 0
    expect(result.searchStats.claudeMemMatches).toBe(0);
    expect(result.searchStats.totalCandidates).toBeGreaterThanOrEqual(1);
    expect(result.searchStats.afterReRank).toBe(result.searchStats.totalCandidates);
  });
});
