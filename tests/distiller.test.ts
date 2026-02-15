import { describe, expect, test } from "bun:test";
import {
  distill,
  DEFAULT_DISTILLER_CONFIG,
} from "../src/distiller/distiller.ts";
import type { Chunk } from "../src/scoring/chunker.ts";
import type { ParsedEvent } from "../src/parsers/types.ts";

function makeEvent(role: "user" | "assistant", content: string): ParsedEvent {
  return {
    type: "message",
    role,
    content,
    timestamp: new Date().toISOString(),
  };
}

function makeChunk(
  id: string,
  sessionId: string,
  startIndex: number,
  tokenEstimate: number,
  importanceAvg: number = 50,
): Chunk {
  const content = "x".repeat(tokenEstimate * 4); // estimateTokens = length / 4
  return {
    id,
    sessionId,
    events: [makeEvent("assistant", content)],
    startIndex,
    endIndex: startIndex + 1,
    importanceAvg,
    tokenEstimate,
  };
}

function makeScoredMap(
  entries: Array<{ id: string; sessionId: string; startIndex: number; tokens: number; consensus: number; importance?: number }>,
): Map<string, { chunk: Chunk; consensus: number }> {
  const map = new Map<string, { chunk: Chunk; consensus: number }>();
  for (const e of entries) {
    const chunk = makeChunk(e.id, e.sessionId, e.startIndex, e.tokens, e.importance ?? 50);
    map.set(e.id, { chunk, consensus: e.consensus });
  }
  return map;
}

describe("distill", () => {
  test("returns empty result for empty input", () => {
    const result = distill(new Map());
    expect(result.chunks).toHaveLength(0);
    expect(result.totalTokens).toBe(0);
    expect(result.droppedChunks).toBe(0);
    expect(result.sourceSessionIds).toEqual([]);
    expect(result.distilledAt).toBeTruthy();
  });

  test("filters chunks below minConsensusScore", () => {
    const scored = makeScoredMap([
      { id: "c1", sessionId: "s1", startIndex: 0, tokens: 100, consensus: 8.0 },
      { id: "c2", sessionId: "s1", startIndex: 10, tokens: 100, consensus: 3.0 },
      { id: "c3", sessionId: "s1", startIndex: 20, tokens: 100, consensus: 6.0 },
    ]);

    const result = distill(scored, { minConsensusScore: 5.0 });
    expect(result.chunks).toHaveLength(2);
    expect(result.droppedChunks).toBe(1);
    const chunkIds = result.chunks.map((c) => c.id);
    expect(chunkIds).toContain("c1");
    expect(chunkIds).toContain("c3");
    expect(chunkIds).not.toContain("c2");
  });

  test("enforces token budget — drops lowest priority chunks", () => {
    const scored = makeScoredMap([
      { id: "c1", sessionId: "s1", startIndex: 0, tokens: 500, consensus: 9.0 },
      { id: "c2", sessionId: "s1", startIndex: 10, tokens: 500, consensus: 7.0 },
      { id: "c3", sessionId: "s1", startIndex: 20, tokens: 500, consensus: 5.5 },
    ]);

    const result = distill(scored, { maxTokens: 1000, minConsensusScore: 5.0 });
    expect(result.chunks).toHaveLength(2);
    expect(result.totalTokens).toBe(1000);
    expect(result.droppedChunks).toBe(1);
  });

  test("sorts by consensus when sortBy is 'consensus'", () => {
    const scored = makeScoredMap([
      { id: "c1", sessionId: "s1", startIndex: 0, tokens: 100, consensus: 5.0 },
      { id: "c2", sessionId: "s1", startIndex: 10, tokens: 100, consensus: 9.0 },
      { id: "c3", sessionId: "s1", startIndex: 20, tokens: 100, consensus: 7.0 },
    ]);

    // Budget allows only 2 chunks — should pick highest consensus (c2=9, c3=7)
    const result = distill(scored, {
      maxTokens: 200,
      minConsensusScore: 5.0,
      sortBy: "consensus",
    });
    expect(result.chunks).toHaveLength(2);
    const ids = result.chunks.map((c) => c.id);
    expect(ids).toContain("c2");
    expect(ids).toContain("c3");
    expect(ids).not.toContain("c1");
  });

  test("sorts by chronological (most recent first) when sortBy is 'chronological'", () => {
    const scored = makeScoredMap([
      { id: "c1", sessionId: "s1", startIndex: 0, tokens: 100, consensus: 9.0 },
      { id: "c2", sessionId: "s1", startIndex: 10, tokens: 100, consensus: 5.0 },
      { id: "c3", sessionId: "s1", startIndex: 20, tokens: 100, consensus: 6.0 },
    ]);

    // Budget allows only 2 — chronological favors most recent (c3=idx20, c2=idx10)
    const result = distill(scored, {
      maxTokens: 200,
      minConsensusScore: 5.0,
      sortBy: "chronological",
    });
    expect(result.chunks).toHaveLength(2);
    const ids = result.chunks.map((c) => c.id);
    expect(ids).toContain("c3");
    expect(ids).toContain("c2");
    expect(ids).not.toContain("c1");
  });

  test("hybrid sort balances consensus and recency", () => {
    const scored = makeScoredMap([
      { id: "c1", sessionId: "s1", startIndex: 0, tokens: 100, consensus: 10.0 },  // high consensus, old
      { id: "c2", sessionId: "s1", startIndex: 10, tokens: 100, consensus: 5.0 },  // low consensus, middle
      { id: "c3", sessionId: "s1", startIndex: 20, tokens: 100, consensus: 8.0 },  // good consensus, recent
    ]);

    // Budget allows only 2 — hybrid should pick c1 (high consensus) and c3 (good + recent)
    const result = distill(scored, {
      maxTokens: 200,
      minConsensusScore: 5.0,
      sortBy: "hybrid",
    });
    expect(result.chunks).toHaveLength(2);
    const ids = result.chunks.map((c) => c.id);
    expect(ids).toContain("c1");
    expect(ids).toContain("c3");
  });

  test("re-sorts selected chunks chronologically in output", () => {
    const scored = makeScoredMap([
      { id: "c1", sessionId: "s1", startIndex: 0, tokens: 100, consensus: 6.0 },
      { id: "c2", sessionId: "s1", startIndex: 10, tokens: 100, consensus: 9.0 },
      { id: "c3", sessionId: "s1", startIndex: 20, tokens: 100, consensus: 7.0 },
    ]);

    const result = distill(scored, { minConsensusScore: 5.0 });
    // Regardless of selection order, output should be chronological
    for (let i = 1; i < result.chunks.length; i++) {
      expect(result.chunks[i].startIndex).toBeGreaterThan(
        result.chunks[i - 1].startIndex,
      );
    }
  });

  test("collects unique source session IDs", () => {
    const scored = makeScoredMap([
      { id: "c1", sessionId: "session-a", startIndex: 0, tokens: 100, consensus: 8.0 },
      { id: "c2", sessionId: "session-b", startIndex: 10, tokens: 100, consensus: 7.0 },
      { id: "c3", sessionId: "session-a", startIndex: 20, tokens: 100, consensus: 6.0 },
    ]);

    const result = distill(scored, { minConsensusScore: 5.0 });
    expect(result.sourceSessionIds).toHaveLength(2);
    expect(result.sourceSessionIds).toContain("session-a");
    expect(result.sourceSessionIds).toContain("session-b");
  });

  test("totalTokens accurately reflects selected chunks", () => {
    const scored = makeScoredMap([
      { id: "c1", sessionId: "s1", startIndex: 0, tokens: 300, consensus: 8.0 },
      { id: "c2", sessionId: "s1", startIndex: 10, tokens: 200, consensus: 7.0 },
    ]);

    const result = distill(scored, { minConsensusScore: 5.0 });
    expect(result.totalTokens).toBe(500);
  });

  test("handles single chunk within budget", () => {
    const scored = makeScoredMap([
      { id: "c1", sessionId: "s1", startIndex: 0, tokens: 100, consensus: 8.0 },
    ]);

    const result = distill(scored, { minConsensusScore: 5.0 });
    expect(result.chunks).toHaveLength(1);
    expect(result.totalTokens).toBe(100);
    expect(result.droppedChunks).toBe(0);
  });

  test("drops all chunks when none meet minimum consensus", () => {
    const scored = makeScoredMap([
      { id: "c1", sessionId: "s1", startIndex: 0, tokens: 100, consensus: 2.0 },
      { id: "c2", sessionId: "s1", startIndex: 10, tokens: 100, consensus: 3.0 },
    ]);

    const result = distill(scored, { minConsensusScore: 5.0 });
    expect(result.chunks).toHaveLength(0);
    expect(result.droppedChunks).toBe(2);
  });

  test("hybrid sort with all same consensus scores favors recency", () => {
    const scored = makeScoredMap([
      { id: "c1", sessionId: "s1", startIndex: 0, tokens: 100, consensus: 7.0 },
      { id: "c2", sessionId: "s1", startIndex: 10, tokens: 100, consensus: 7.0 },
      { id: "c3", sessionId: "s1", startIndex: 20, tokens: 100, consensus: 7.0 },
    ]);

    // All consensus equal → recency breaks tie → c3 (most recent) favored
    const result = distill(scored, {
      maxTokens: 200,
      minConsensusScore: 5.0,
      sortBy: "hybrid",
    });
    expect(result.chunks).toHaveLength(2);
    const ids = result.chunks.map((c) => c.id);
    expect(ids).toContain("c3");
    expect(ids).toContain("c2");
  });

  test("respects custom hybrid weights", () => {
    const scored = makeScoredMap([
      { id: "c1", sessionId: "s1", startIndex: 0, tokens: 100, consensus: 10.0 },  // high consensus, oldest
      { id: "c2", sessionId: "s1", startIndex: 10, tokens: 100, consensus: 5.0 },  // low consensus, newest
    ]);

    // With recencyWeight=0.9, consensusWeight=0.1, recency dominates
    const result = distill(scored, {
      maxTokens: 100,
      minConsensusScore: 5.0,
      sortBy: "hybrid",
      hybridConsensusWeight: 0.1,
      hybridRecencyWeight: 0.9,
    });
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0].id).toBe("c2"); // most recent wins
  });
});

describe("DEFAULT_DISTILLER_CONFIG", () => {
  test("has expected defaults", () => {
    expect(DEFAULT_DISTILLER_CONFIG.maxTokens).toBe(80000);
    expect(DEFAULT_DISTILLER_CONFIG.minConsensusScore).toBe(5.0);
    expect(DEFAULT_DISTILLER_CONFIG.includeSystemContext).toBe(true);
    expect(DEFAULT_DISTILLER_CONFIG.sortBy).toBe("hybrid");
    expect(DEFAULT_DISTILLER_CONFIG.hybridConsensusWeight).toBe(0.7);
    expect(DEFAULT_DISTILLER_CONFIG.hybridRecencyWeight).toBe(0.3);
  });
});
