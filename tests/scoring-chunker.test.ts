import { describe, expect, test } from "bun:test";
import { buildChunks, estimateTokens, DEFAULT_CHUNK_CONFIG } from "../src/scoring/chunker.ts";
import type { ParsedEvent } from "../src/parsers/types.ts";

/** Create a ParsedEvent with controllable content length and type. */
function makeEvent(overrides: Partial<ParsedEvent> = {}): ParsedEvent {
  return {
    type: "assistant",
    role: "assistant",
    content: "Hello world",
    ...overrides,
  };
}

/** Create N events with default assistant role (base score 50, passes default threshold of 30). */
function makeEvents(count: number, contentPrefix = "Event"): ParsedEvent[] {
  return Array.from({ length: count }, (_, i) =>
    makeEvent({ content: `${contentPrefix} ${i}` })
  );
}

/** Create an event that will score below the default threshold (30). */
function makeLowScoreEvent(): ParsedEvent {
  // system + hook + long content = 50 - 20 - 15 - 5 = 10
  return makeEvent({
    type: "hook_pre",
    role: "system",
    content: "x".repeat(2001),
  });
}

describe("estimateTokens", () => {
  test("estimates tokens as ceil(length / 4)", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("hi")).toBe(1);
    expect(estimateTokens("hello")).toBe(2);
    expect(estimateTokens("12345678")).toBe(2);
    expect(estimateTokens("123456789")).toBe(3);
  });
});

describe("buildChunks", () => {
  test("returns empty array for empty events", () => {
    const chunks = buildChunks([]);
    expect(chunks).toEqual([]);
  });

  test("returns empty array when all events are below threshold", () => {
    const events = [makeLowScoreEvent(), makeLowScoreEvent()];
    const chunks = buildChunks(events);
    expect(chunks).toEqual([]);
  });

  test("creates a single chunk for a small number of events", () => {
    const events = makeEvents(5);
    const chunks = buildChunks(events, "session_1");
    expect(chunks).toHaveLength(1);
    expect(chunks[0].sessionId).toBe("session_1");
    expect(chunks[0].events).toHaveLength(5);
    expect(chunks[0].startIndex).toBe(0);
    expect(chunks[0].endIndex).toBe(4);
    expect(chunks[0].importanceAvg).toBeGreaterThan(0);
    expect(chunks[0].tokenEstimate).toBeGreaterThan(0);
    expect(chunks[0].id).toMatch(/^req_/);
  });

  test("filters events below minImportanceThreshold", () => {
    const events = [
      makeEvent({ content: "Good event", role: "user", type: "user" }), // score 60
      makeLowScoreEvent(), // score ~10
      makeEvent({ content: "Another good event" }), // score 50
    ];
    const chunks = buildChunks(events, "session_2");
    expect(chunks).toHaveLength(1);
    // Only 2 events should pass threshold
    expect(chunks[0].events).toHaveLength(2);
  });

  test("groups events into multiple chunks based on maxEventsPerChunk", () => {
    const events = makeEvents(10);
    const chunks = buildChunks(events, "session_3", { maxEventsPerChunk: 3, overlapEvents: 0 });
    // 10 events / 3 per chunk = 4 chunks (3, 3, 3, 1)
    expect(chunks).toHaveLength(4);
    expect(chunks[0].events).toHaveLength(3);
    expect(chunks[1].events).toHaveLength(3);
    expect(chunks[2].events).toHaveLength(3);
    expect(chunks[3].events).toHaveLength(1);
  });

  test("splits chunks that exceed maxTokensPerChunk", () => {
    // Each event has ~250 chars = ~63 tokens. 5 events = ~315 tokens.
    const events = Array.from({ length: 5 }, (_, i) =>
      makeEvent({ content: "x".repeat(250) + ` event_${i}` })
    );
    const chunks = buildChunks(events, "session_4", {
      maxEventsPerChunk: 100, // Allow all in one window
      maxTokensPerChunk: 200, // Force token-based splitting
      overlapEvents: 0,
    });
    // Should be split into multiple chunks based on token budget
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.tokenEstimate).toBeLessThanOrEqual(200);
    }
  });

  test("adds overlap events from previous chunk", () => {
    const events = makeEvents(6);
    const chunks = buildChunks(events, "session_5", {
      maxEventsPerChunk: 3,
      overlapEvents: 2,
    });
    // First chunk: 3 events
    // Second chunk: 2 overlap + 3 new = 5 events
    expect(chunks).toHaveLength(2);
    expect(chunks[0].events).toHaveLength(3);
    expect(chunks[1].events).toHaveLength(5); // 2 overlap + 3 new

    // Verify overlap: last 2 events of chunk 0 should be first 2 of chunk 1
    const lastTwo = chunks[0].events.slice(-2);
    const firstTwo = chunks[1].events.slice(0, 2);
    expect(firstTwo[0].content).toBe(lastTwo[0].content);
    expect(firstTwo[1].content).toBe(lastTwo[1].content);
  });

  test("overlap does not exceed previous chunk size", () => {
    const events = makeEvents(3);
    const chunks = buildChunks(events, "session_6", {
      maxEventsPerChunk: 2,
      overlapEvents: 5, // More than any chunk has
    });
    expect(chunks).toHaveLength(2);
    // Overlap should be min(5, prevChunkSize=2) = 2
    expect(chunks[1].events.length).toBeGreaterThanOrEqual(2);
  });

  test("no overlap when overlapEvents is 0", () => {
    const events = makeEvents(6);
    const chunks = buildChunks(events, "session_7", {
      maxEventsPerChunk: 3,
      overlapEvents: 0,
    });
    expect(chunks).toHaveLength(2);
    expect(chunks[0].events).toHaveLength(3);
    expect(chunks[1].events).toHaveLength(3);
  });

  test("uses default session ID when not provided", () => {
    const events = makeEvents(2);
    const chunks = buildChunks(events);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].sessionId).toBe("unknown");
  });

  test("each chunk gets a unique ID", () => {
    const events = makeEvents(10);
    const chunks = buildChunks(events, "session_8", {
      maxEventsPerChunk: 3,
      overlapEvents: 0,
    });
    const ids = chunks.map((c) => c.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });

  test("importanceAvg is calculated correctly", () => {
    // All events are plain assistant messages with base score 50
    const events = makeEvents(4);
    const chunks = buildChunks(events, "session_9", { overlapEvents: 0 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].importanceAvg).toBe(50);
  });

  test("tokenEstimate reflects total event content", () => {
    const events = [
      makeEvent({ content: "abcd" }),     // 4 chars → 1 token
      makeEvent({ content: "efghijkl" }), // 8 chars → 2 tokens
    ];
    const chunks = buildChunks(events, "session_10", { overlapEvents: 0 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].tokenEstimate).toBe(3); // 1 + 2
  });

  test("handles mixed high and low score events", () => {
    const events = [
      makeEvent({ role: "user", type: "user", content: "question" }), // score 60
      makeLowScoreEvent(), // below threshold
      makeEvent({ toolName: "Edit", content: "editing file" }), // score 77
      makeLowScoreEvent(), // below threshold
      makeEvent({ content: "response" }), // score 50
    ];
    const chunks = buildChunks(events, "session_11", { overlapEvents: 0 });
    expect(chunks).toHaveLength(1);
    // Only 3 events should pass (indices 0, 2, 4)
    expect(chunks[0].events).toHaveLength(3);
  });

  test("preserves original indices in startIndex and endIndex", () => {
    const events = [
      makeLowScoreEvent(), // index 0, filtered out
      makeEvent({ content: "first good" }), // index 1
      makeLowScoreEvent(), // index 2, filtered out
      makeEvent({ content: "second good" }), // index 3
    ];
    const chunks = buildChunks(events, "session_12", { overlapEvents: 0 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].startIndex).toBe(1);
    expect(chunks[0].endIndex).toBe(3);
  });

  test("custom threshold allows more events through", () => {
    // With threshold 0, even low-score events pass
    const events = [makeLowScoreEvent(), makeEvent({ content: "normal" })];
    const chunks = buildChunks(events, "session_13", { minImportanceThreshold: 0, overlapEvents: 0 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].events).toHaveLength(2);
  });
});
