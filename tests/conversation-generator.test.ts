import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  conversationGenerator,
  generatePreamble,
  generateSessionId,
  generateUserTurn,
  generateAssistantTurn,
} from "../src/output/conversationGenerator";
import type { DistilledSession } from "../src/distiller/distiller";
import type { Chunk } from "../src/scoring/chunker";
import type { ParsedEvent } from "../src/parsers/types";

function makeChunk(id: string, content: string, role: "user" | "assistant" = "assistant"): Chunk {
  const event: ParsedEvent = {
    type: `${role}_message`,
    role,
    content,
    timestamp: new Date().toISOString(),
  };
  return {
    id,
    sessionId: "session_test",
    events: [event],
    startIndex: 0,
    endIndex: 0,
    importanceAvg: 75,
    tokenEstimate: Math.ceil(content.length / 4),
  };
}

function makeDistilledSession(chunks: Chunk[]): DistilledSession {
  return {
    sourceSessionIds: ["session_1", "session_2"],
    sourcePlatforms: ["claude", "codex"],
    chunks,
    totalTokens: chunks.reduce((sum, c) => sum + c.tokenEstimate, 0),
    droppedChunks: 0,
    distilledAt: new Date().toISOString(),
  };
}

describe("conversation generator", () => {
  test("11.17: generateSessionId returns valid UUID format", () => {
    const id = generateSessionId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  test("11.17: generatePreamble includes project path and session count", () => {
    const distilled = makeDistilledSession([]);
    const preamble = generatePreamble("/path/to/project", distilled);
    expect(preamble).toContain("/path/to/project");
    expect(preamble).toContain("2 most recent session(s)");
    expect(preamble).toContain("claude, codex");
  });

  test("11.17: generateUserTurn returns topic-relevant question", () => {
    const turn = generateUserTurn("architecture and design", 2);
    expect(turn).toContain("architecture and design");
  });

  test("11.17: generateAssistantTurn formats chunk content", () => {
    const chunks = [makeChunk("c1", "The gateway uses adapter pattern for normalization.")];
    const turn = generateAssistantTurn(chunks);
    expect(turn).toContain("adapter pattern");
  });

  test("11.17: generated JSONL has valid event structure", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ua-convgen-test-"));
    const outputPath = join(dir, "test-session.jsonl");

    const chunks = [
      makeChunk("c1", "The project uses TypeScript with Bun runtime."),
      makeChunk("c2", "SQLite with WAL mode is used for persistence."),
    ];
    const distilled = makeDistilledSession(chunks);

    await conversationGenerator.generate(distilled, outputPath, {
      cwd: "/test/project",
      gitBranch: "main",
    });

    const content = await readFile(outputPath, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBeGreaterThan(0);

    for (const line of lines) {
      const event = JSON.parse(line);

      // Required fields on every event
      expect(event.type).toBeDefined();
      expect(["user", "assistant"]).toContain(event.type);
      expect(event.uuid).toBeDefined();
      expect(event.uuid).toMatch(/^[0-9a-f]{8}-/);
      expect(event.sessionId).toBeDefined();
      expect(event.cwd).toBe("/test/project");
      expect(event.timestamp).toBeDefined();
      expect(event.version).toBeDefined();
      expect(event.isSidechain).toBe(false);
      expect(event.userType).toBe("external");
      expect(event.message).toBeDefined();

      if (event.type === "user") {
        expect(event.message.role).toBe("user");
        expect(typeof event.message.content).toBe("string");
      } else if (event.type === "assistant") {
        expect(event.message.role).toBe("assistant");
        expect(event.message.type).toBe("message");
        expect(event.message.model).toBeDefined();
        expect(event.message.id).toBeDefined();
        expect(Array.isArray(event.message.content)).toBe(true);
        expect(event.message.content[0].type).toBe("text");
        expect(event.message.stop_reason).toBe("end_turn");
        expect(event.message.usage).toBeDefined();
        expect(event.message.usage.input_tokens).toBeGreaterThan(0);
        expect(event.message.usage.output_tokens).toBeGreaterThan(0);
      }
    }
  });

  test("11.18: uuid chain is consistent — no orphaned parentUuid references", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ua-uuid-chain-"));
    const outputPath = join(dir, "uuid-test.jsonl");

    const chunks = [
      makeChunk("c1", "Architecture uses event-driven design."),
      makeChunk("c2", "Deployment is via Railway."),
      makeChunk("c3", "Tests use bun:test framework."),
    ];
    const distilled = makeDistilledSession(chunks);

    await conversationGenerator.generate(distilled, outputPath, { cwd: "/test" });

    const content = await readFile(outputPath, "utf-8");
    const events = content.trim().split("\n").map((l) => JSON.parse(l));

    // Collect all UUIDs
    const uuids = new Set(events.map((e: any) => e.uuid));

    // First event should have parentUuid null
    expect(events[0].parentUuid).toBeNull();

    // All other events should reference a valid parent
    for (let i = 1; i < events.length; i++) {
      const parentUuid = events[i].parentUuid;
      expect(parentUuid).not.toBeNull();
      expect(uuids.has(parentUuid)).toBe(true);
    }

    // Each parentUuid should point to the immediately preceding event
    for (let i = 1; i < events.length; i++) {
      expect(events[i].parentUuid).toBe(events[i - 1].uuid);
    }

    // All UUIDs should be unique
    expect(uuids.size).toBe(events.length);

    // All events share the same sessionId
    const sessionIds = new Set(events.map((e: any) => e.sessionId));
    expect(sessionIds.size).toBe(1);
  });

  test("11.19: output produces alternating user/assistant turns", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ua-turns-"));
    const outputPath = join(dir, "turns-test.jsonl");

    const chunks = [makeChunk("c1", "Some project knowledge content here.")];
    const distilled = makeDistilledSession(chunks);

    await conversationGenerator.generate(distilled, outputPath, { cwd: "/test" });

    const content = await readFile(outputPath, "utf-8");
    const events = content.trim().split("\n").map((l) => JSON.parse(l));

    // Should have at least preamble user + overview assistant + topic user + topic assistant
    expect(events.length).toBeGreaterThanOrEqual(4);

    // Events should alternate: user, assistant, user, assistant, ...
    for (let i = 0; i < events.length; i++) {
      const expectedType = i % 2 === 0 ? "user" : "assistant";
      expect(events[i].type).toBe(expectedType);
    }
  });

  test("11.19: timestamps increase monotonically", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ua-timestamp-"));
    const outputPath = join(dir, "ts-test.jsonl");

    const chunks = [
      makeChunk("c1", "First topic content."),
      makeChunk("c2", "Second topic content."),
    ];
    const distilled = makeDistilledSession(chunks);

    await conversationGenerator.generate(distilled, outputPath, { cwd: "/test" });

    const content = await readFile(outputPath, "utf-8");
    const events = content.trim().split("\n").map((l) => JSON.parse(l));

    for (let i = 1; i < events.length; i++) {
      const prevTs = new Date(events[i - 1].timestamp).getTime();
      const currTs = new Date(events[i].timestamp).getTime();
      expect(currTs).toBeGreaterThan(prevTs);
    }
  });

  test("11.17: gitBranch is populated from options", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ua-branch-"));
    const outputPath = join(dir, "branch-test.jsonl");

    const distilled = makeDistilledSession([makeChunk("c1", "Content.")]);

    await conversationGenerator.generate(distilled, outputPath, {
      cwd: "/test",
      gitBranch: "feature/new-thing",
    });

    const content = await readFile(outputPath, "utf-8");
    const events = content.trim().split("\n").map((l) => JSON.parse(l));

    for (const event of events) {
      expect(event.gitBranch).toBe("feature/new-thing");
    }
  });
});
