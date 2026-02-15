import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { claudeGenerator } from "../src/output/claudeGenerator.ts";
import type { DistilledSession } from "../src/distiller/distiller.ts";
import type { Chunk } from "../src/scoring/chunker.ts";
import type { ParsedEvent } from "../src/parsers/types.ts";
import { existsSync, unlinkSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "claude-gen-test-"));
});

afterEach(() => {
  // Clean up temp files
  const outputPath = join(tempDir, "output.jsonl");
  if (existsSync(outputPath)) unlinkSync(outputPath);
});

function makeEvent(role: "user" | "assistant", content: string): ParsedEvent {
  return { type: "message", role, content, timestamp: "2026-01-15T00:00:00Z" };
}

function makeChunk(id: string, events: ParsedEvent[]): Chunk {
  return {
    id,
    sessionId: "test-session",
    events,
    startIndex: 0,
    endIndex: events.length - 1,
    importanceAvg: 75,
    tokenEstimate: events.reduce((sum, e) => sum + Math.ceil(e.content.length / 4), 0),
  };
}

function makeDistilledSession(chunks: Chunk[]): DistilledSession {
  return {
    sourceSessionIds: ["session-1"],
    sourcePlatforms: ["claude"],
    chunks,
    totalTokens: chunks.reduce((sum, c) => sum + c.tokenEstimate, 0),
    droppedChunks: 0,
    distilledAt: "2026-01-15T12:00:00.000Z",
  };
}

describe("claudeGenerator", () => {
  test("has correct platform identifier", () => {
    expect(claudeGenerator.platform).toBe("claude");
  });

  test("generates valid JSONL output", async () => {
    const chunk = makeChunk("c1", [
      makeEvent("user", "What is TypeScript?"),
      makeEvent("assistant", "TypeScript is a typed superset of JavaScript."),
    ]);
    const distilled = makeDistilledSession([chunk]);
    const outputPath = join(tempDir, "output.jsonl");

    await claudeGenerator.generate(distilled, outputPath);

    const content = await Bun.file(outputPath).text();
    const lines = content.trim().split("\n");

    // Each line should be valid JSON
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  test("first line is compact_boundary header", async () => {
    const chunk = makeChunk("c1", [makeEvent("assistant", "Hello")]);
    const distilled = makeDistilledSession([chunk]);
    const outputPath = join(tempDir, "output.jsonl");

    await claudeGenerator.generate(distilled, outputPath);

    const content = await Bun.file(outputPath).text();
    const lines = content.trim().split("\n");
    const header = JSON.parse(lines[0]);

    expect(header.type).toBe("summary");
    expect(header.role).toBe("system");
    expect(header.content).toBe("compact_boundary");
    expect(header.compact_boundary).toBe(true);
    expect(header.is_sidechain).toBe(true);
    expect(header.sourceSessionIds).toEqual(["session-1"]);
    expect(header.sourcePlatforms).toEqual(["claude"]);
    expect(header.chunkCount).toBe(1);
  });

  test("chunk lines contain system-reminder wrapped content", async () => {
    const chunk = makeChunk("c1", [
      makeEvent("assistant", "TypeScript is great"),
    ]);
    const distilled = makeDistilledSession([chunk]);
    const outputPath = join(tempDir, "output.jsonl");

    await claudeGenerator.generate(distilled, outputPath);

    const content = await Bun.file(outputPath).text();
    const lines = content.trim().split("\n");
    // Line 0 is header, line 1 is chunk
    expect(lines.length).toBe(2);

    const chunkLine = JSON.parse(lines[1]);
    expect(chunkLine.type).toBe("summary");
    expect(chunkLine.role).toBe("assistant");
    expect(chunkLine.is_sidechain).toBe(true);
    expect(chunkLine.content).toContain("<system-reminder>");
    expect(chunkLine.content).toContain("</system-reminder>");
    expect(chunkLine.chunkId).toBe("c1");
  });

  test("formats tool events with name, input, and output", async () => {
    const toolEvent: ParsedEvent = {
      type: "tool_use",
      role: "assistant",
      content: "",
      toolName: "Read",
      toolInput: "/path/to/file.ts",
      toolOutput: "file contents here",
      timestamp: "2026-01-15T00:00:00Z",
    };
    const chunk = makeChunk("c1", [toolEvent]);
    const distilled = makeDistilledSession([chunk]);
    const outputPath = join(tempDir, "output.jsonl");

    await claudeGenerator.generate(distilled, outputPath);

    const content = await Bun.file(outputPath).text();
    const lines = content.trim().split("\n");
    const chunkLine = JSON.parse(lines[1]);

    expect(chunkLine.content).toContain("Tool: Read");
    expect(chunkLine.content).toContain("Input: /path/to/file.ts");
    expect(chunkLine.content).toContain("Output: file contents here");
  });

  test("generates multiple chunks as separate lines", async () => {
    const chunk1 = makeChunk("c1", [makeEvent("user", "Question 1")]);
    const chunk2 = makeChunk("c2", [makeEvent("assistant", "Answer 2")]);
    const distilled = makeDistilledSession([chunk1, chunk2]);
    const outputPath = join(tempDir, "output.jsonl");

    await claudeGenerator.generate(distilled, outputPath);

    const content = await Bun.file(outputPath).text();
    const lines = content.trim().split("\n");
    // 1 header + 2 chunks = 3 lines
    expect(lines).toHaveLength(3);
  });

  test("returns the output path", async () => {
    const chunk = makeChunk("c1", [makeEvent("assistant", "Hello")]);
    const distilled = makeDistilledSession([chunk]);
    const outputPath = join(tempDir, "output.jsonl");

    const result = await claudeGenerator.generate(distilled, outputPath);
    expect(result).toBe(outputPath);
  });

  test("handles empty chunks array", async () => {
    const distilled = makeDistilledSession([]);
    const outputPath = join(tempDir, "output.jsonl");

    await claudeGenerator.generate(distilled, outputPath);

    const content = await Bun.file(outputPath).text();
    const lines = content.trim().split("\n");
    // Just the header
    expect(lines).toHaveLength(1);
    const header = JSON.parse(lines[0]);
    expect(header.chunkCount).toBe(0);
  });
});
