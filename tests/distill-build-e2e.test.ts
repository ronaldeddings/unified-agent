/**
 * 13.19-13.20: End-to-end integration test for the distill build pipeline.
 *
 * Exercises: score → chunk → distill → synthesize → generate JSONL
 * Uses mock data (no real CLI spawning or session scanning).
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ParsedEvent } from "../src/parsers/types";
import { scoreEvent } from "../src/scoring/importance";
import { buildChunks } from "../src/scoring/chunker";
import { distill } from "../src/distiller/distiller";
import { groupByTopic, assembleSynthesis } from "../src/synthesis/synthesizer";
import { conversationGenerator } from "../src/output/conversationGenerator";

/** Create a realistic set of ParsedEvents simulating a real project session. */
function createFixtureEvents(): ParsedEvent[] {
  const now = new Date();
  const events: ParsedEvent[] = [
    {
      type: "user_message",
      role: "user",
      content: "Let's set up the project architecture. I want an event-driven design with a gateway adapter pattern.",
      timestamp: new Date(now.getTime() - 3600000).toISOString(),
    },
    {
      type: "assistant_message",
      role: "assistant",
      content: "I'll design the architecture using an event-driven pattern with adapters for each provider. The system will have a gateway layer that normalizes requests, adapter modules for Claude/Codex/Gemini, and a shared event bus. The main components are: 1) Gateway - receives requests, 2) Adapters - translate to provider-specific formats, 3) Event bus - coordinates async responses.",
      timestamp: new Date(now.getTime() - 3590000).toISOString(),
    },
    {
      type: "user_message",
      role: "user",
      content: "What about the file structure? How should we organize src/?",
      timestamp: new Date(now.getTime() - 3500000).toISOString(),
    },
    {
      type: "assistant_message",
      role: "assistant",
      content: "The directory structure follows: src/gateway/ for the main entry point, src/adapters/ for provider-specific code, src/parsers/ for session file parsers, src/scoring/ for importance scoring, src/output/ for generators, and src/storage/ for SQLite persistence. Each module has an index.ts barrel export.",
      timestamp: new Date(now.getTime() - 3490000).toISOString(),
    },
    {
      type: "user_message",
      role: "user",
      content: "We decided to use Bun as the runtime instead of Node. The trade-off is ecosystem maturity vs speed.",
      timestamp: new Date(now.getTime() - 3000000).toISOString(),
    },
    {
      type: "assistant_message",
      role: "assistant",
      content: "Good decision. Bun gives us significant speed advantages: native TypeScript support (no tsc step), fast package management, built-in SQLite via bun:sqlite, and the Bun.file/Bun.write APIs for efficient file I/O. The trade-off of ecosystem maturity is acceptable since we're not using many Node-specific packages.",
      timestamp: new Date(now.getTime() - 2990000).toISOString(),
    },
    {
      type: "user_message",
      role: "user",
      content: "Deploy this to Railway with a Dockerfile.",
      timestamp: new Date(now.getTime() - 2000000).toISOString(),
    },
    {
      type: "assistant_message",
      role: "assistant",
      content: "I'll set up deployment to Railway. The Dockerfile uses the official Bun image, copies source and installs dependencies, then runs `bun run start`. Railway auto-detects the Dockerfile and builds on push. Environment variables are configured in the Railway dashboard.",
      timestamp: new Date(now.getTime() - 1990000).toISOString(),
    },
    {
      type: "user_message",
      role: "user",
      content: "There's a bug in the error handler — it silently swallows connection timeouts.",
      timestamp: new Date(now.getTime() - 1000000).toISOString(),
    },
    {
      type: "assistant_message",
      role: "assistant",
      content: "Found the bug. The error handler catches all errors but only logs non-timeout errors. Connection timeouts are silently swallowed because the catch block checks `error.code !== 'ETIMEDOUT'` but the actual code is `ECONNRESET`. Fixed by removing the code filter and logging all errors, then re-throwing timeouts for upstream handling.",
      timestamp: new Date(now.getTime() - 990000).toISOString(),
    },
    {
      type: "tool_result",
      role: "tool",
      content: "Tests pass: 42 passing, 0 failing",
      timestamp: new Date(now.getTime() - 980000).toISOString(),
      toolName: "bun_test",
      toolOutput: "42 passing, 0 failing",
    },
  ];
  return events;
}

describe("distill build e2e (13.19-13.20)", () => {
  test("full pipeline: fixture events → scored → chunked → distilled → synthesized → JSONL", async () => {
    const events = createFixtureEvents();
    const dir = await mkdtemp(join(tmpdir(), "ua-e2e-build-"));
    const outputPath = join(dir, "e2e-build.jsonl");

    // Step 1: Score events
    const scoredEvents = events.map((event) => {
      const score = scoreEvent(event);
      return { ...event, metadata: { ...event.metadata, importanceScore: score } };
    });
    expect(scoredEvents.length).toBe(events.length);

    // Step 2: Build chunks
    const chunks = buildChunks(scoredEvents, "fixture-session-1");
    expect(chunks.length).toBeGreaterThan(0);

    // Step 3: Create mock consensus scores (no real CLI spawning)
    const scoredChunks = new Map<string, { chunk: typeof chunks[0]; consensus: number }>();
    for (let i = 0; i < chunks.length; i++) {
      scoredChunks.set(chunks[i].id, {
        chunk: chunks[i],
        consensus: 7.0 + (i * 0.5), // Ascending mock scores
      });
    }

    // Step 4: Distill
    const distilled = distill(scoredChunks, { maxTokens: 50000 });
    expect(distilled.chunks.length).toBeGreaterThan(0);
    expect(distilled.totalTokens).toBeGreaterThan(0);
    expect(distilled.totalTokens).toBeLessThanOrEqual(50000);

    // Step 5: Synthesize
    const groups = groupByTopic(distilled.chunks);
    expect(groups.size).toBeGreaterThan(0);

    const synthesis = assembleSynthesis(groups);
    expect(synthesis.length).toBeGreaterThan(0);

    // Verify topics are in narrative order
    const topicOrder = synthesis.map((s) => s.topic);
    for (let i = 1; i < topicOrder.length; i++) {
      const NARRATIVE = ["overview", "architecture", "file-structure", "patterns", "decisions", "dependencies", "deployment", "recent-changes", "known-issues"];
      expect(NARRATIVE.indexOf(topicOrder[i - 1])).toBeLessThanOrEqual(NARRATIVE.indexOf(topicOrder[i]));
    }

    // Step 6: Generate JSONL
    const synthesizedDistilled = {
      ...distilled,
      sourcePlatforms: ["claude"],
      sourceSessionIds: ["fixture-session-1"],
    };
    await conversationGenerator.generate(synthesizedDistilled, outputPath, {
      cwd: "/test/project",
      gitBranch: "main",
    });

    // Step 7: Verify output
    const content = await readFile(outputPath, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(4); // At least preamble + overview + 1 topic Q&A

    // Verify all events are valid JSON with required fields
    const jsonEvents = lines.map((l) => JSON.parse(l));
    for (const event of jsonEvents) {
      expect(event.type).toBeDefined();
      expect(["user", "assistant"]).toContain(event.type);
      expect(event.uuid).toBeDefined();
      expect(event.sessionId).toBeDefined();
      expect(event.cwd).toBe("/test/project");
      expect(event.timestamp).toBeDefined();
      expect(event.version).toBeDefined();
      expect(event.isSidechain).toBe(false);
      expect(event.message).toBeDefined();
    }

    // Verify alternating user/assistant
    for (let i = 0; i < jsonEvents.length; i++) {
      expect(jsonEvents[i].type).toBe(i % 2 === 0 ? "user" : "assistant");
    }

    // Verify uuid chain
    expect(jsonEvents[0].parentUuid).toBeNull();
    for (let i = 1; i < jsonEvents.length; i++) {
      expect(jsonEvents[i].parentUuid).toBe(jsonEvents[i - 1].uuid);
    }

    // Verify all UUIDs are unique
    const uuids = new Set(jsonEvents.map((e: any) => e.uuid));
    expect(uuids.size).toBe(jsonEvents.length);
  });

  test("pipeline respects token budget", async () => {
    const events = createFixtureEvents();

    const scoredEvents = events.map((event) => {
      const score = scoreEvent(event);
      return { ...event, metadata: { ...event.metadata, importanceScore: score } };
    });

    const chunks = buildChunks(scoredEvents, "fixture-session-1");

    const scoredChunks = new Map<string, { chunk: typeof chunks[0]; consensus: number }>();
    for (const chunk of chunks) {
      scoredChunks.set(chunk.id, { chunk, consensus: 8.0 });
    }

    // Use very small budget to force dropping
    const distilled = distill(scoredChunks, { maxTokens: 100 });
    expect(distilled.totalTokens).toBeLessThanOrEqual(100);
    expect(distilled.droppedChunks).toBeGreaterThanOrEqual(0);
  });

  test("pipeline handles empty input gracefully", async () => {
    const chunks = buildChunks([], "empty-session");
    expect(chunks.length).toBe(0);

    const scoredChunks = new Map<string, { chunk: typeof chunks[0]; consensus: number }>();
    const distilled = distill(scoredChunks);
    expect(distilled.chunks.length).toBe(0);
    expect(distilled.totalTokens).toBe(0);
  });

  test("13.20: verify correct counts through pipeline", async () => {
    const events = createFixtureEvents();
    expect(events.length).toBe(11); // 11 fixture events

    const scoredEvents = events.map((event) => {
      const score = scoreEvent(event);
      return { ...event, metadata: { ...event.metadata, importanceScore: score } };
    });

    const chunks = buildChunks(scoredEvents, "fixture-session-1");
    // Chunks should be fewer than events (grouping + filtering)
    expect(chunks.length).toBeLessThanOrEqual(events.length);
    expect(chunks.length).toBeGreaterThan(0);

    // Every chunk should have at least one event
    for (const chunk of chunks) {
      expect(chunk.events.length).toBeGreaterThan(0);
      expect(chunk.tokenEstimate).toBeGreaterThan(0);
    }
  });
});
