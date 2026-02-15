/**
 * Integration tests for the full distillation pipeline.
 * Items 83-86: Ingest platform session → parse → score → chunk → distill → generate output.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { claudeParser } from "../src/parsers/claudeParser.ts";
import { codexParser } from "../src/parsers/codexParser.ts";
import { geminiParser } from "../src/parsers/geminiParser.ts";
import { scoreEvent } from "../src/scoring/importance.ts";
import { buildChunks } from "../src/scoring/chunker.ts";
import { distill } from "../src/distiller/distiller.ts";
import { getGenerator } from "../src/output/index.ts";
import type { ParsedEvent } from "../src/parsers/types.ts";
import type { Chunk } from "../src/scoring/chunker.ts";

// --- Mock session data ---

function makeClaudeSession(): string {
  return [
    JSON.stringify({ type: "user", content: "Fix the authentication bug in auth.ts", timestamp: "2026-01-15T10:00:00Z" }),
    JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "I'll fix the authentication bug. The issue is in the token validation:\n```typescript\nif (!token || token.expired) return false;\n```" },
          { type: "tool_use", name: "Edit", id: "tool_1", input: { file: "auth.ts", content: "fixed code" } },
        ],
        model: "claude-sonnet-4-5-20250929",
      },
      timestamp: "2026-01-15T10:00:05Z",
    }),
    JSON.stringify({
      type: "user",
      content: [{ type: "tool_result", tool_use_id: "tool_1", content: "File saved successfully" }],
      timestamp: "2026-01-15T10:00:10Z",
    }),
    JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "The authentication bug has been fixed. Token validation now properly rejects expired tokens." }],
        model: "claude-sonnet-4-5-20250929",
      },
      timestamp: "2026-01-15T10:00:15Z",
    }),
    JSON.stringify({ type: "user", content: "Run the tests", timestamp: "2026-01-15T10:00:20Z" }),
    JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "All 42 tests passed." }],
        model: "claude-sonnet-4-5-20250929",
      },
      timestamp: "2026-01-15T10:00:25Z",
    }),
  ].join("\n");
}

function makeCodexSession(): string {
  return [
    JSON.stringify({
      type: "item.completed",
      item: { role: "user", content: [{ type: "text", text: "Refactor the database module" }] },
      timestamp: "2026-01-15T11:00:00Z",
    }),
    JSON.stringify({
      type: "item.completed",
      item: {
        type: "command_execution",
        name: "shell",
        arguments: "cat src/db.ts",
        output: [{ type: "output_text", text: "export class Database { ... }" }],
        status: "completed",
      },
      timestamp: "2026-01-15T11:00:05Z",
    }),
    JSON.stringify({
      type: "item.completed",
      item: {
        role: "assistant",
        content: [{ type: "text", text: "I've read the database module. Here's the refactored version with connection pooling:\n```typescript\nexport class Database {\n  private pool: Pool;\n}\n```" }],
      },
      timestamp: "2026-01-15T11:00:10Z",
    }),
    JSON.stringify({
      type: "item.completed",
      item: {
        type: "command_execution",
        name: "shell",
        arguments: "bun test src/db.test.ts",
        output: [{ type: "output_text", text: "3 tests passed" }],
        status: "completed",
      },
      timestamp: "2026-01-15T11:00:15Z",
    }),
    JSON.stringify({
      type: "turn.completed",
      response: { usage: { input_tokens: 1200, output_tokens: 800, total_tokens: 2000 }, model: "gpt-5" },
      timestamp: "2026-01-15T11:00:20Z",
    }),
  ].join("\n");
}

function makeGeminiSession(): string {
  return JSON.stringify([
    { type: "message", role: "user", content: "What is the project structure?", timestamp: "2026-01-15T12:00:00Z" },
    {
      type: "message",
      role: "assistant",
      content: "The project uses a standard TypeScript layout with src/, tests/, and scripts/ directories.",
      timestamp: "2026-01-15T12:00:05Z",
    },
    {
      type: "tool_call",
      name: "read_file",
      args: { path: "package.json" },
      timestamp: "2026-01-15T12:00:10Z",
    },
    {
      type: "tool_result",
      name: "read_file",
      result: { content: '{"name":"unified-agent"}' },
      timestamp: "2026-01-15T12:00:12Z",
    },
    {
      type: "message",
      role: "assistant",
      content: "The package.json confirms this is the unified-agent project. Let me also check tsconfig.",
      timestamp: "2026-01-15T12:00:15Z",
    },
    { type: "message", role: "user", content: "What dependencies does it use?", timestamp: "2026-01-15T12:00:20Z" },
    {
      type: "message",
      role: "assistant",
      content: "The project uses Bun as its runtime and has no external npm dependencies — it relies on Bun built-ins.",
      timestamp: "2026-01-15T12:00:25Z",
    },
  ]);
}

// --- Helper: run full pipeline ---

async function runPipeline(
  parser: { parse(source: string): AsyncGenerator<ParsedEvent> },
  sessionData: string,
  sessionId: string,
): Promise<{ events: ParsedEvent[]; chunks: Chunk[]; distilled: ReturnType<typeof distill> }> {
  // Parse
  const events: ParsedEvent[] = [];
  for await (const event of parser.parse(sessionData)) {
    events.push(event);
  }

  // Score
  for (const event of events) {
    const score = scoreEvent(event);
    event.metadata = { ...event.metadata, importanceScore: score };
  }

  // Chunk
  const chunks = buildChunks(events, sessionId, {
    minImportanceThreshold: 20,
    maxEventsPerChunk: 10,
  });

  // Distill (mock consensus — no actual provider CLIs)
  const scoredChunks = new Map<string, { chunk: Chunk; consensus: number }>();
  for (const chunk of chunks) {
    scoredChunks.set(chunk.id, { chunk, consensus: 7.0 + Math.random() * 2 });
  }

  const distilled = distill(scoredChunks, { minConsensusScore: 5.0 });

  return { events, chunks, distilled };
}

// --- Tests ---

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "distill-integration-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("Item 83: Claude JSONL full pipeline", () => {
  test("ingest Claude session → full pipeline → valid Claude JSONL output", async () => {
    const { events, chunks, distilled } = await runPipeline(
      claudeParser,
      makeClaudeSession(),
      "claude-test-session",
    );

    // Verify parsing
    expect(events.length).toBeGreaterThanOrEqual(4);
    expect(events.some((e) => e.role === "user")).toBe(true);
    expect(events.some((e) => e.role === "assistant")).toBe(true);

    // Verify scoring
    for (const event of events) {
      const score = event.metadata?.importanceScore as number;
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(100);
    }

    // Verify chunking
    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      expect(chunk.events.length).toBeGreaterThan(0);
      expect(chunk.tokenEstimate).toBeGreaterThan(0);
    }

    // Verify distillation
    expect(distilled.chunks.length).toBeGreaterThan(0);
    expect(distilled.totalTokens).toBeGreaterThan(0);

    // Generate Claude output and validate format
    const outputPath = join(tmpDir, "claude-output.jsonl");
    await getGenerator("claude").generate(distilled, outputPath);

    const output = await Bun.file(outputPath).text();
    const lines = output.trim().split("\n").filter(Boolean);

    expect(lines.length).toBeGreaterThan(0);

    // Every line must be valid JSON
    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed).toHaveProperty("type");
      expect(parsed).toHaveProperty("content");
      expect(parsed).toHaveProperty("timestamp");
    }

    // First line should be the compact_boundary header
    const header = JSON.parse(lines[0]);
    expect(header.compact_boundary).toBe(true);
    expect(header.is_sidechain).toBe(true);
    expect(header.type).toBe("summary");
  });
});

describe("Item 84: Codex JSONL full pipeline", () => {
  test("ingest Codex session → full pipeline → valid Codex JSONL output", async () => {
    const { events, chunks, distilled } = await runPipeline(
      codexParser,
      makeCodexSession(),
      "codex-test-session",
    );

    // Verify parsing
    expect(events.length).toBeGreaterThanOrEqual(3);

    // Verify chunking
    expect(chunks.length).toBeGreaterThan(0);

    // Verify distillation
    expect(distilled.chunks.length).toBeGreaterThan(0);

    // Generate Codex output and validate format
    const outputPath = join(tmpDir, "codex-output.jsonl");
    await getGenerator("codex").generate(distilled, outputPath);

    const output = await Bun.file(outputPath).text();
    const lines = output.trim().split("\n").filter(Boolean);

    expect(lines.length).toBeGreaterThan(0);

    // Every line must be valid JSON
    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed).toHaveProperty("type");
    }

    // First line should be metadata header
    const header = JSON.parse(lines[0]);
    expect(header.type).toBe("metadata");
    expect(header).toHaveProperty("sourceSessionIds");
    expect(header).toHaveProperty("totalTokens");

    // Subsequent lines should be context events
    if (lines.length > 1) {
      const contextLine = JSON.parse(lines[1]);
      expect(contextLine.type).toBe("context");
      expect(contextLine.role).toBe("assistant");
      expect(contextLine).toHaveProperty("content");
    }
  });
});

describe("Item 85: Gemini JSON full pipeline", () => {
  test("ingest Gemini session → full pipeline → valid Gemini JSON output", async () => {
    const { events, chunks, distilled } = await runPipeline(
      geminiParser,
      makeGeminiSession(),
      "gemini-test-session",
    );

    // Verify parsing
    expect(events.length).toBeGreaterThanOrEqual(4);

    // Verify chunking
    expect(chunks.length).toBeGreaterThan(0);

    // Verify distillation
    expect(distilled.chunks.length).toBeGreaterThan(0);

    // Generate Gemini output and validate format
    const outputPath = join(tmpDir, "gemini-output.json");
    await getGenerator("gemini").generate(distilled, outputPath);

    const output = await Bun.file(outputPath).text();
    const parsed = JSON.parse(output);

    // Must have metadata and contents
    expect(parsed).toHaveProperty("metadata");
    expect(parsed).toHaveProperty("contents");
    expect(Array.isArray(parsed.contents)).toBe(true);
    expect(parsed.metadata).toHaveProperty("sourceSessionIds");
    expect(parsed.metadata).toHaveProperty("totalTokens");
    expect(parsed.metadata).toHaveProperty("distilledAt");

    // Each content entry must have role and parts
    for (const content of parsed.contents) {
      expect(content).toHaveProperty("role");
      expect(["user", "model"]).toContain(content.role);
      expect(content).toHaveProperty("parts");
      expect(Array.isArray(content.parts)).toBe(true);
      for (const part of content.parts) {
        expect(part).toHaveProperty("text");
        expect(typeof part.text).toBe("string");
      }
    }
  });
});

describe("Item 86: Cross-platform — Claude input → Gemini output", () => {
  test("ingest Claude session, generate Gemini output, verify format", async () => {
    const { distilled } = await runPipeline(
      claudeParser,
      makeClaudeSession(),
      "claude-cross-platform",
    );

    // Generate Gemini output from Claude-sourced distillation
    const outputPath = join(tmpDir, "cross-platform-gemini.json");
    await getGenerator("gemini").generate(distilled, outputPath);

    const output = await Bun.file(outputPath).text();
    const parsed = JSON.parse(output);

    // Validate Gemini format
    expect(parsed).toHaveProperty("metadata");
    expect(parsed).toHaveProperty("contents");
    expect(Array.isArray(parsed.contents)).toBe(true);

    // Metadata should reference the source
    expect(parsed.metadata.chunkCount).toBeGreaterThan(0);
    expect(parsed.metadata.totalTokens).toBeGreaterThan(0);

    // Contents should have valid Gemini structure
    for (const content of parsed.contents) {
      expect(["user", "model"]).toContain(content.role);
      expect(Array.isArray(content.parts)).toBe(true);
    }

    // Verify we have actual content (not empty)
    const totalParts = parsed.contents.reduce(
      (sum: number, c: { parts: unknown[] }) => sum + c.parts.length,
      0,
    );
    expect(totalParts).toBeGreaterThan(0);
  });
});
