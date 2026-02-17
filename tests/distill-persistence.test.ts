import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionDb } from "../src/storage/sqlite";
import type { Chunk } from "../src/scoring/chunker";
import type { ParsedEvent } from "../src/parsers/types";

function makeChunk(id: string, sessionId: string, content: string): Chunk {
  const event: ParsedEvent = {
    type: "assistant_message",
    role: "assistant",
    content,
    timestamp: new Date().toISOString(),
  };
  return {
    id,
    sessionId,
    events: [event],
    startIndex: 0,
    endIndex: 0,
    importanceAvg: 75,
    tokenEstimate: Math.ceil(content.length / 4),
  };
}

describe("distill persistence", () => {
  test("10.18: persistChunk writes to chunks table and is retrievable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ua-persist-test-"));
    const db = new SessionDb(join(dir, "test.sqlite"));

    const chunk = makeChunk("chunk_001", "session_abc", "The adapter pattern is used for normalization.");
    db.persistChunk(chunk, 0, 8.5);

    const retrieved = db.getChunk("chunk_001");
    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe("chunk_001");
    expect(retrieved!.metaSessionId).toBe("session_abc");
    expect(retrieved!.consensusScore).toBe(8.5);
    expect(retrieved!.tokenCount).toBe(chunk.tokenEstimate);
    expect(retrieved!.summary).toContain("adapter pattern");

    db.close();
  });

  test("10.18: persistChunk handles re-run with INSERT OR REPLACE", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ua-persist-rerun-"));
    const db = new SessionDb(join(dir, "test.sqlite"));

    const chunk = makeChunk("chunk_dup", "session_xyz", "Original content.");
    db.persistChunk(chunk, 0, 7.0);

    // Re-run with updated score
    db.persistChunk(chunk, 0, 9.0);

    const retrieved = db.getChunk("chunk_dup");
    expect(retrieved).not.toBeNull();
    expect(retrieved!.consensusScore).toBe(9.0);

    db.close();
  });

  test("10.19: persistChunkFTS enables full-text search queries", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ua-fts-test-"));
    const db = new SessionDb(join(dir, "test.sqlite"));

    // Persist a chunk first (required for foreign key if enforced)
    const chunk1 = makeChunk("chunk_fts_1", "session_fts", "The gateway router dispatches requests to providers.");
    db.persistChunk(chunk1, 0, 8.0);
    db.persistChunkFTS("chunk_fts_1", "The gateway router dispatches requests to providers.");

    const chunk2 = makeChunk("chunk_fts_2", "session_fts", "SQLite WAL mode enables concurrent reads.");
    db.persistChunk(chunk2, 1, 7.5);
    db.persistChunkFTS("chunk_fts_2", "SQLite WAL mode enables concurrent reads.");

    // Search for gateway-related content
    const results = db.searchChunksFts("gateway router", 10);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].chunkId).toBe("chunk_fts_1");
    expect(results[0].content).toContain("gateway");

    // Search for SQLite content
    const sqliteResults = db.searchChunksFts("SQLite WAL", 10);
    expect(sqliteResults.length).toBeGreaterThan(0);
    expect(sqliteResults[0].chunkId).toBe("chunk_fts_2");

    // Search for non-existent content returns empty
    const noResults = db.searchChunksFts("kubernetes deployment", 10);
    expect(noResults.length).toBe(0);

    db.close();
  });
});
