import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { geminiGenerator } from "../src/output/geminiGenerator.ts";
import type { DistilledSession } from "../src/distiller/distiller.ts";
import type { Chunk } from "../src/scoring/chunker.ts";
import type { ParsedEvent } from "../src/parsers/types.ts";
import { existsSync, unlinkSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "gemini-gen-test-"));
});

afterEach(() => {
  const outputPath = join(tempDir, "output.json");
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
    sourcePlatforms: ["gemini"],
    chunks,
    totalTokens: chunks.reduce((sum, c) => sum + c.tokenEstimate, 0),
    droppedChunks: 0,
    distilledAt: "2026-01-15T12:00:00.000Z",
  };
}

describe("geminiGenerator", () => {
  test("has correct platform identifier", () => {
    expect(geminiGenerator.platform).toBe("gemini");
  });

  test("generates valid JSON output", async () => {
    const chunk = makeChunk("c1", [
      makeEvent("user", "What is Gemini?"),
      makeEvent("assistant", "Gemini is Google's AI model."),
    ]);
    const distilled = makeDistilledSession([chunk]);
    const outputPath = join(tempDir, "output.json");

    await geminiGenerator.generate(distilled, outputPath);

    const content = await Bun.file(outputPath).text();
    expect(() => JSON.parse(content)).not.toThrow();
  });

  test("includes metadata section", async () => {
    const chunk = makeChunk("c1", [makeEvent("assistant", "Hello")]);
    const distilled = makeDistilledSession([chunk]);
    const outputPath = join(tempDir, "output.json");

    await geminiGenerator.generate(distilled, outputPath);

    const content = await Bun.file(outputPath).text();
    const session = JSON.parse(content);

    expect(session.metadata).toBeDefined();
    expect(session.metadata.sourceSessionIds).toEqual(["session-1"]);
    expect(session.metadata.sourcePlatforms).toEqual(["gemini"]);
    expect(session.metadata.chunkCount).toBe(1);
    expect(session.metadata.distilledAt).toBe("2026-01-15T12:00:00.000Z");
  });

  test("maps assistant role to 'model'", async () => {
    const chunk = makeChunk("c1", [
      makeEvent("assistant", "I am the model"),
    ]);
    const distilled = makeDistilledSession([chunk]);
    const outputPath = join(tempDir, "output.json");

    await geminiGenerator.generate(distilled, outputPath);

    const content = await Bun.file(outputPath).text();
    const session = JSON.parse(content);

    expect(session.contents).toHaveLength(1);
    expect(session.contents[0].role).toBe("model");
  });

  test("maps user role to 'user'", async () => {
    const chunk = makeChunk("c1", [
      makeEvent("user", "Hello from user"),
    ]);
    const distilled = makeDistilledSession([chunk]);
    const outputPath = join(tempDir, "output.json");

    await geminiGenerator.generate(distilled, outputPath);

    const content = await Bun.file(outputPath).text();
    const session = JSON.parse(content);

    expect(session.contents).toHaveLength(1);
    expect(session.contents[0].role).toBe("user");
  });

  test("content has parts array with text fields", async () => {
    const chunk = makeChunk("c1", [
      makeEvent("user", "Tell me about TypeScript"),
    ]);
    const distilled = makeDistilledSession([chunk]);
    const outputPath = join(tempDir, "output.json");

    await geminiGenerator.generate(distilled, outputPath);

    const content = await Bun.file(outputPath).text();
    const session = JSON.parse(content);

    expect(session.contents[0].parts).toBeArray();
    expect(session.contents[0].parts).toHaveLength(1);
    expect(session.contents[0].parts[0].text).toBe("Tell me about TypeScript");
  });

  test("groups consecutive same-role events into one content block", async () => {
    const chunk = makeChunk("c1", [
      makeEvent("assistant", "First thought"),
      makeEvent("assistant", "Second thought"),
      makeEvent("user", "User response"),
    ]);
    const distilled = makeDistilledSession([chunk]);
    const outputPath = join(tempDir, "output.json");

    await geminiGenerator.generate(distilled, outputPath);

    const content = await Bun.file(outputPath).text();
    const session = JSON.parse(content);

    // 2 content blocks: model (2 parts), user (1 part)
    expect(session.contents).toHaveLength(2);
    expect(session.contents[0].role).toBe("model");
    expect(session.contents[0].parts).toHaveLength(2);
    expect(session.contents[0].parts[0].text).toBe("First thought");
    expect(session.contents[0].parts[1].text).toBe("Second thought");
    expect(session.contents[1].role).toBe("user");
    expect(session.contents[1].parts).toHaveLength(1);
  });

  test("formats tool events with name, input, output", async () => {
    const toolEvent: ParsedEvent = {
      type: "tool_use",
      role: "assistant",
      content: "",
      toolName: "Grep",
      toolInput: "pattern: foo",
      toolOutput: "found in bar.ts",
      timestamp: "2026-01-15T00:00:00Z",
    };
    const chunk = makeChunk("c1", [toolEvent]);
    const distilled = makeDistilledSession([chunk]);
    const outputPath = join(tempDir, "output.json");

    await geminiGenerator.generate(distilled, outputPath);

    const content = await Bun.file(outputPath).text();
    const session = JSON.parse(content);

    const text = session.contents[0].parts[0].text;
    expect(text).toContain("Tool: Grep");
    expect(text).toContain("Input: pattern: foo");
    expect(text).toContain("Output: found in bar.ts");
  });

  test("handles multiple chunks — merges contents in order", async () => {
    const chunk1 = makeChunk("c1", [makeEvent("user", "First question")]);
    const chunk2 = makeChunk("c2", [makeEvent("assistant", "First answer")]);
    const distilled = makeDistilledSession([chunk1, chunk2]);
    const outputPath = join(tempDir, "output.json");

    await geminiGenerator.generate(distilled, outputPath);

    const content = await Bun.file(outputPath).text();
    const session = JSON.parse(content);

    expect(session.contents).toHaveLength(2);
    expect(session.contents[0].role).toBe("user");
    expect(session.contents[1].role).toBe("model");
  });

  test("returns the output path", async () => {
    const chunk = makeChunk("c1", [makeEvent("assistant", "Hello")]);
    const distilled = makeDistilledSession([chunk]);
    const outputPath = join(tempDir, "output.json");

    const result = await geminiGenerator.generate(distilled, outputPath);
    expect(result).toBe(outputPath);
  });

  test("handles empty chunks array", async () => {
    const distilled = makeDistilledSession([]);
    const outputPath = join(tempDir, "output.json");

    await geminiGenerator.generate(distilled, outputPath);

    const content = await Bun.file(outputPath).text();
    const session = JSON.parse(content);

    expect(session.contents).toEqual([]);
    expect(session.metadata.chunkCount).toBe(0);
  });

  test("output is pretty-printed JSON", async () => {
    const chunk = makeChunk("c1", [makeEvent("user", "Hello")]);
    const distilled = makeDistilledSession([chunk]);
    const outputPath = join(tempDir, "output.json");

    await geminiGenerator.generate(distilled, outputPath);

    const content = await Bun.file(outputPath).text();
    // Pretty-printed JSON should contain newlines and indentation
    expect(content).toContain("\n");
    expect(content).toContain("  ");
  });
});
