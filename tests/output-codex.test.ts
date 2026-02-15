import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { codexGenerator } from "../src/output/codexGenerator.ts";
import type { DistilledSession } from "../src/distiller/distiller.ts";
import type { Chunk } from "../src/scoring/chunker.ts";
import type { ParsedEvent } from "../src/parsers/types.ts";
import { existsSync, unlinkSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "codex-gen-test-"));
});

afterEach(() => {
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
    sourcePlatforms: ["codex"],
    chunks,
    totalTokens: chunks.reduce((sum, c) => sum + c.tokenEstimate, 0),
    droppedChunks: 0,
    distilledAt: "2026-01-15T12:00:00.000Z",
  };
}

describe("codexGenerator", () => {
  test("has correct platform identifier", () => {
    expect(codexGenerator.platform).toBe("codex");
  });

  test("generates valid JSONL output", async () => {
    const chunk = makeChunk("c1", [
      makeEvent("user", "How do I use Codex?"),
      makeEvent("assistant", "Codex is a CLI tool for coding."),
    ]);
    const distilled = makeDistilledSession([chunk]);
    const outputPath = join(tempDir, "output.jsonl");

    await codexGenerator.generate(distilled, outputPath);

    const content = await Bun.file(outputPath).text();
    const lines = content.trim().split("\n");

    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  test("first line is metadata header", async () => {
    const chunk = makeChunk("c1", [makeEvent("assistant", "Hello")]);
    const distilled = makeDistilledSession([chunk]);
    const outputPath = join(tempDir, "output.jsonl");

    await codexGenerator.generate(distilled, outputPath);

    const content = await Bun.file(outputPath).text();
    const lines = content.trim().split("\n");
    const header = JSON.parse(lines[0]);

    expect(header.type).toBe("metadata");
    expect(header.version).toBe(1);
    expect(header.sourceSessionIds).toEqual(["session-1"]);
    expect(header.sourcePlatforms).toEqual(["codex"]);
    expect(header.chunkCount).toBe(1);
    expect(header.distilledAt).toBe("2026-01-15T12:00:00.000Z");
  });

  test("chunk lines have type: context", async () => {
    const chunk = makeChunk("c1", [
      makeEvent("assistant", "Some coding context"),
    ]);
    const distilled = makeDistilledSession([chunk]);
    const outputPath = join(tempDir, "output.jsonl");

    await codexGenerator.generate(distilled, outputPath);

    const content = await Bun.file(outputPath).text();
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(2);

    const contextLine = JSON.parse(lines[1]);
    expect(contextLine.type).toBe("context");
    expect(contextLine.role).toBe("assistant");
    expect(contextLine.content).toContain("Some coding context");
    expect(contextLine.metadata.chunkId).toBe("c1");
    expect(contextLine.metadata.sessionId).toBe("test-session");
  });

  test("formats tool events correctly", async () => {
    const toolEvent: ParsedEvent = {
      type: "tool_use",
      role: "assistant",
      content: "",
      toolName: "Bash",
      toolInput: "ls -la",
      toolOutput: "total 42",
      timestamp: "2026-01-15T00:00:00Z",
    };
    const chunk = makeChunk("c1", [toolEvent]);
    const distilled = makeDistilledSession([chunk]);
    const outputPath = join(tempDir, "output.jsonl");

    await codexGenerator.generate(distilled, outputPath);

    const content = await Bun.file(outputPath).text();
    const lines = content.trim().split("\n");
    const contextLine = JSON.parse(lines[1]);

    expect(contextLine.content).toContain("Tool: Bash");
    expect(contextLine.content).toContain("Input: ls -la");
    expect(contextLine.content).toContain("Output: total 42");
  });

  test("generates multiple chunks as separate lines", async () => {
    const chunk1 = makeChunk("c1", [makeEvent("user", "Question 1")]);
    const chunk2 = makeChunk("c2", [makeEvent("assistant", "Answer 2")]);
    const distilled = makeDistilledSession([chunk1, chunk2]);
    const outputPath = join(tempDir, "output.jsonl");

    await codexGenerator.generate(distilled, outputPath);

    const content = await Bun.file(outputPath).text();
    const lines = content.trim().split("\n");
    // 1 metadata + 2 context lines = 3
    expect(lines).toHaveLength(3);
  });

  test("returns the output path", async () => {
    const chunk = makeChunk("c1", [makeEvent("assistant", "Hello")]);
    const distilled = makeDistilledSession([chunk]);
    const outputPath = join(tempDir, "output.jsonl");

    const result = await codexGenerator.generate(distilled, outputPath);
    expect(result).toBe(outputPath);
  });

  test("includes chunk metadata in context lines", async () => {
    const chunk = makeChunk("c1", [makeEvent("assistant", "Important code")]);
    chunk.importanceAvg = 85;
    chunk.tokenEstimate = 250;
    chunk.startIndex = 5;
    chunk.endIndex = 10;
    const distilled = makeDistilledSession([chunk]);
    const outputPath = join(tempDir, "output.jsonl");

    await codexGenerator.generate(distilled, outputPath);

    const content = await Bun.file(outputPath).text();
    const lines = content.trim().split("\n");
    const contextLine = JSON.parse(lines[1]);

    expect(contextLine.metadata.importanceAvg).toBe(85);
    expect(contextLine.metadata.tokenEstimate).toBe(250);
    expect(contextLine.metadata.startIndex).toBe(5);
    expect(contextLine.metadata.endIndex).toBe(10);
  });

  test("handles empty chunks array", async () => {
    const distilled = makeDistilledSession([]);
    const outputPath = join(tempDir, "output.jsonl");

    await codexGenerator.generate(distilled, outputPath);

    const content = await Bun.file(outputPath).text();
    const lines = content.trim().split("\n");
    // Just metadata header
    expect(lines).toHaveLength(1);
    const header = JSON.parse(lines[0]);
    expect(header.chunkCount).toBe(0);
  });
});
