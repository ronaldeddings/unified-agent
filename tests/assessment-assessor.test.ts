import { describe, expect, test, mock, beforeEach } from "bun:test";
import type { Chunk } from "../src/scoring/chunker.ts";
import type { ParsedEvent } from "../src/parsers/types.ts";

// Mock runStreamingCommand before importing assessor
const mockRunStreamingCommand = mock(() =>
  Promise.resolve({
    stdout: '{"relevance": 8, "signalDensity": 7, "reusability": 9, "overallScore": 8, "rationale": "Good chunk"}',
    stderr: "",
    code: 0,
  }),
);

mock.module("../src/providers/stream.ts", () => ({
  runStreamingCommand: mockRunStreamingCommand,
  toOneLine: (s: string, max = 140) => {
    const v = s.replace(/\s+/g, " ").trim();
    return v.length <= max ? v : `${v.slice(0, max - 1)}…`;
  },
  safeJsonParse: (line: string) => {
    try { return JSON.parse(line); } catch { return null; }
  },
}));

// Import after mock is set up
const { assessChunk, assessChunks, DEFAULT_ASSESSOR_CONFIG } = await import("../src/assessment/assessor.ts");

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
    id: "chunk_test_001",
    sessionId: "session_test_001",
    events: [makeEvent()],
    startIndex: 0,
    endIndex: 0,
    importanceAvg: 50,
    tokenEstimate: 100,
    ...overrides,
  };
}

describe("assessChunk", () => {
  beforeEach(() => {
    mockRunStreamingCommand.mockClear();
    mockRunStreamingCommand.mockImplementation(() =>
      Promise.resolve({
        stdout: '{"relevance": 8, "signalDensity": 7, "reusability": 9, "overallScore": 8, "rationale": "Good chunk"}',
        stderr: "",
        code: 0,
      }),
    );
  });

  test("returns assessment results from all providers", async () => {
    const chunk = makeChunk();
    const results = await assessChunk(chunk, {
      providers: ["claude", "codex", "gemini"],
      cwd: "/tmp",
    });

    expect(results.length).toBe(3);
    for (const r of results) {
      expect(r.chunkId).toBe("chunk_test_001");
      expect(r.score).toBe(8);
      expect(r.rationale).toBe("Good chunk");
      expect(r.latencyMs).toBeGreaterThanOrEqual(0);
    }

    // Each provider spawns one CLI call
    expect(mockRunStreamingCommand).toHaveBeenCalledTimes(3);
  });

  test("returns results for subset of providers", async () => {
    const chunk = makeChunk();
    const results = await assessChunk(chunk, {
      providers: ["claude"],
      cwd: "/tmp",
    });

    expect(results.length).toBe(1);
    expect(results[0].provider).toBe("claude");
  });

  test("spawns correct CLI for claude provider", async () => {
    await assessChunk(makeChunk(), { providers: ["claude"], cwd: "/tmp" });

    const call = mockRunStreamingCommand.mock.calls[0];
    expect(call[0]).toBe("claude");
    expect(call[1]).toContain("-p");
    expect(call[1]).toContain("--dangerously-skip-permissions");
  });

  test("spawns correct CLI for codex provider", async () => {
    await assessChunk(makeChunk(), { providers: ["codex"], cwd: "/tmp" });

    const call = mockRunStreamingCommand.mock.calls[0];
    expect(call[0]).toBe("codex");
    expect(call[1]).toContain("exec");
    expect(call[1]).toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  test("spawns correct CLI for gemini provider", async () => {
    await assessChunk(makeChunk(), { providers: ["gemini"], cwd: "/tmp" });

    const call = mockRunStreamingCommand.mock.calls[0];
    expect(call[0]).toBe("gemini");
    expect(call[1]).toContain("--yolo");
  });

  test("handles provider failure gracefully — returns empty for failed provider", async () => {
    mockRunStreamingCommand.mockImplementation(() =>
      Promise.resolve({ stdout: "", stderr: "error", code: 1 }),
    );

    const results = await assessChunk(makeChunk(), {
      providers: ["claude"],
      cwd: "/tmp",
      retryOnFailure: false,
    });

    expect(results.length).toBe(0);
  });

  test("retries failed provider once when retryOnFailure is true", async () => {
    let callCount = 0;
    mockRunStreamingCommand.mockImplementation(() => {
      callCount++;
      if (callCount <= 1) {
        return Promise.resolve({ stdout: "", stderr: "error", code: 1 });
      }
      return Promise.resolve({
        stdout: '{"relevance": 7, "signalDensity": 6, "reusability": 8, "overallScore": 7, "rationale": "Retry succeeded"}',
        stderr: "",
        code: 0,
      });
    });

    const results = await assessChunk(makeChunk(), {
      providers: ["claude"],
      cwd: "/tmp",
      retryOnFailure: true,
    });

    expect(results.length).toBe(1);
    expect(results[0].score).toBe(7);
    expect(results[0].rationale).toBe("Retry succeeded");
    // First attempt + retry = 2 calls
    expect(mockRunStreamingCommand).toHaveBeenCalledTimes(2);
  });

  test("handles invalid JSON from provider", async () => {
    mockRunStreamingCommand.mockImplementation(() =>
      Promise.resolve({ stdout: "I cannot assess this.", stderr: "", code: 0 }),
    );

    const results = await assessChunk(makeChunk(), {
      providers: ["claude"],
      cwd: "/tmp",
      retryOnFailure: false,
    });

    expect(results.length).toBe(0);
  });

  test("handles provider exception gracefully", async () => {
    mockRunStreamingCommand.mockImplementation(() =>
      Promise.reject(new Error("spawn failed")),
    );

    const results = await assessChunk(makeChunk(), {
      providers: ["claude"],
      cwd: "/tmp",
      retryOnFailure: false,
    });

    expect(results.length).toBe(0);
  });
});

describe("assessChunks", () => {
  beforeEach(() => {
    mockRunStreamingCommand.mockClear();
    mockRunStreamingCommand.mockImplementation(() =>
      Promise.resolve({
        stdout: '{"relevance": 8, "signalDensity": 7, "reusability": 9, "overallScore": 8, "rationale": "Good chunk"}',
        stderr: "",
        code: 0,
      }),
    );
  });

  test("returns map of chunk ID to assessment results", async () => {
    const chunks = [
      makeChunk({ id: "chunk_a" }),
      makeChunk({ id: "chunk_b" }),
    ];

    const resultMap = await assessChunks(chunks, {
      providers: ["claude"],
      cwd: "/tmp",
    });

    expect(resultMap.size).toBe(2);
    expect(resultMap.has("chunk_a")).toBe(true);
    expect(resultMap.has("chunk_b")).toBe(true);
    expect(resultMap.get("chunk_a")!.length).toBe(1);
    expect(resultMap.get("chunk_b")!.length).toBe(1);
  });

  test("reports progress for each completed chunk", async () => {
    const chunks = [
      makeChunk({ id: "chunk_1" }),
      makeChunk({ id: "chunk_2" }),
      makeChunk({ id: "chunk_3" }),
    ];

    const progressUpdates: Array<[number, number]> = [];

    await assessChunks(
      chunks,
      { providers: ["claude"], cwd: "/tmp", maxConcurrent: 2 },
      (completed, total) => progressUpdates.push([completed, total]),
    );

    expect(progressUpdates.length).toBe(3);
    expect(progressUpdates[0]).toEqual([1, 3]);
    expect(progressUpdates[1]).toEqual([2, 3]);
    expect(progressUpdates[2]).toEqual([3, 3]);
  });

  test("respects maxConcurrent batching", async () => {
    const chunks = [
      makeChunk({ id: "c1" }),
      makeChunk({ id: "c2" }),
      makeChunk({ id: "c3" }),
      makeChunk({ id: "c4" }),
      makeChunk({ id: "c5" }),
    ];

    const resultMap = await assessChunks(chunks, {
      providers: ["claude"],
      cwd: "/tmp",
      maxConcurrent: 2,
    });

    expect(resultMap.size).toBe(5);
  });

  test("handles empty chunks array", async () => {
    const resultMap = await assessChunks([], {
      providers: ["claude"],
      cwd: "/tmp",
    });

    expect(resultMap.size).toBe(0);
  });
});

describe("DEFAULT_ASSESSOR_CONFIG", () => {
  test("has expected defaults", () => {
    expect(DEFAULT_ASSESSOR_CONFIG.providers).toEqual(["claude", "codex", "gemini"]);
    expect(DEFAULT_ASSESSOR_CONFIG.timeoutMs).toBe(30000);
    expect(DEFAULT_ASSESSOR_CONFIG.maxConcurrent).toBe(3);
    expect(DEFAULT_ASSESSOR_CONFIG.retryOnFailure).toBe(true);
  });
});
