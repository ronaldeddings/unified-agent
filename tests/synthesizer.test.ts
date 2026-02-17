import { describe, expect, test } from "bun:test";
import type { Chunk } from "../src/scoring/chunker";
import type { ParsedEvent } from "../src/parsers/types";
import {
  classifyChunkTopic,
  groupByTopic,
  deduplicateWithinGroup,
  resolveContradictions,
  assembleSynthesis,
  generateConversationFromSynthesis,
  TOPIC_TAXONOMY,
  NARRATIVE_ORDER,
} from "../src/synthesis/synthesizer";

function makeEvent(content: string, role: "user" | "assistant" = "assistant", timestamp?: string): ParsedEvent {
  return {
    type: `${role}_message`,
    role,
    content,
    timestamp: timestamp || new Date().toISOString(),
  };
}

function makeChunk(
  id: string,
  content: string,
  opts?: { role?: "user" | "assistant"; importance?: number; timestamp?: string },
): Chunk {
  const role = opts?.role || "assistant";
  const timestamp = opts?.timestamp || new Date().toISOString();
  return {
    id,
    sessionId: "session_test",
    events: [makeEvent(content, role, timestamp)],
    startIndex: 0,
    endIndex: 0,
    importanceAvg: opts?.importance ?? 75,
    tokenEstimate: Math.ceil(content.length / 4),
  };
}

// ─── 12.9: Classifier assigns correct topics ───────────────────────────────

describe("synthesizer — topic classifier (12.9)", () => {
  test("classifies architecture content", () => {
    const chunk = makeChunk("c1", "The system design uses an event-driven architecture with a gateway adapter pattern for all modules.");
    expect(classifyChunkTopic(chunk)).toBe("architecture");
  });

  test("classifies deployment content", () => {
    const chunk = makeChunk("c2", "We deploy to production via Railway with GitHub Actions CI/CD pipeline and Docker containers.");
    expect(classifyChunkTopic(chunk)).toBe("deployment");
  });

  test("classifies known-issues content", () => {
    const chunk = makeChunk("c3", "There's a bug in the error handler causing a memory leak. Added a workaround as a TODO for technical debt.");
    expect(classifyChunkTopic(chunk)).toBe("known-issues");
  });

  test("classifies dependencies content", () => {
    const chunk = makeChunk("c4", "The runtime is Bun with TypeScript. Key dependencies include React framework and npm packages.");
    expect(classifyChunkTopic(chunk)).toBe("dependencies");
  });

  test("classifies decisions content", () => {
    const chunk = makeChunk("c5", "We decided to use SQLite instead of Postgres. The trade-off was simplicity over scalability. We considered Redis but rejected it.");
    expect(classifyChunkTopic(chunk)).toBe("decisions");
  });

  test("classifies recent-changes content", () => {
    const chunk = makeChunk("c6", "Just added a new feature today. Changed the API and updated the commit with a recent merge PR.");
    expect(classifyChunkTopic(chunk)).toBe("recent-changes");
  });

  test("classifies file-structure content", () => {
    const chunk = makeChunk("c7", "The directory layout has src/ with index.ts, lib/ folder, and package.json at root. The file structure follows conventions.");
    expect(classifyChunkTopic(chunk)).toBe("file-structure");
  });

  test("classifies patterns content", () => {
    const chunk = makeChunk("c8", "The codebase uses a factory pattern and middleware convention. The naming style follows best practice idioms.");
    expect(classifyChunkTopic(chunk)).toBe("patterns");
  });

  test("falls back to overview for generic content", () => {
    const chunk = makeChunk("c9", "Hello world this is some random text with no particular topic keywords at all.");
    expect(classifyChunkTopic(chunk)).toBe("overview");
  });
});

// ─── 12.10: Deduplication removes overlapping chunks ────────────────────────

describe("synthesizer — deduplication (12.10)", () => {
  test("removes near-duplicate chunks by Jaccard similarity", () => {
    const chunk1 = makeChunk("c1", "The gateway uses an adapter pattern for normalization of incoming requests across all services.", { importance: 80 });
    const chunk2 = makeChunk("c2", "The gateway uses an adapter pattern for normalization of incoming requests across all services.", { importance: 70 });
    const result = deduplicateWithinGroup([chunk1, chunk2]);
    expect(result.length).toBe(1);
    expect(result[0].id).toBe("c1"); // Higher importance kept
  });

  test("keeps distinct chunks", () => {
    const chunk1 = makeChunk("c1", "The gateway uses an adapter pattern for normalization.");
    const chunk2 = makeChunk("c2", "We deploy to Railway with Docker containers and CI pipeline.");
    const result = deduplicateWithinGroup([chunk1, chunk2]);
    expect(result.length).toBe(2);
  });

  test("handles single chunk", () => {
    const chunk = makeChunk("c1", "Some content here.");
    const result = deduplicateWithinGroup([chunk]);
    expect(result.length).toBe(1);
  });

  test("handles empty array", () => {
    const result = deduplicateWithinGroup([]);
    expect(result.length).toBe(0);
  });

  test("keeps higher importance chunk when deduplicating", () => {
    const lowImportance = makeChunk("c1", "The architecture design uses layers and modules and components for the system.", { importance: 50 });
    const highImportance = makeChunk("c2", "The architecture design uses layers and modules and components for the system.", { importance: 90 });
    const result = deduplicateWithinGroup([lowImportance, highImportance]);
    expect(result.length).toBe(1);
    expect(result[0].id).toBe("c2"); // Higher importance kept
  });
});

// ─── 12.11: Contradiction resolution keeps latest ───────────────────────────

describe("synthesizer — contradiction resolution (12.11)", () => {
  test("sorts chunks by timestamp ascending (latest last)", () => {
    const early = makeChunk("c1", "Old approach to deployment.", { timestamp: "2026-01-01T00:00:00Z" });
    const late = makeChunk("c2", "New deployment approach.", { timestamp: "2026-02-15T00:00:00Z" });
    const result = resolveContradictions([late, early]);
    expect(result[0].id).toBe("c1"); // Early first
    expect(result[1].id).toBe("c2"); // Late last (most recent = authoritative)
  });

  test("handles single chunk", () => {
    const chunk = makeChunk("c1", "Content.", { timestamp: "2026-01-01T00:00:00Z" });
    const result = resolveContradictions([chunk]);
    expect(result.length).toBe(1);
  });

  test("handles chunks without timestamps", () => {
    const chunk1 = makeChunk("c1", "No timestamp chunk one.");
    const chunk2 = makeChunk("c2", "No timestamp chunk two.");
    // Remove timestamps
    chunk1.events[0].timestamp = undefined;
    chunk2.events[0].timestamp = undefined;
    const result = resolveContradictions([chunk1, chunk2]);
    expect(result.length).toBe(2);
  });
});

// ─── Integration: assembleSynthesis + generateConversationFromSynthesis ─────

describe("synthesizer — assembly and conversation generation", () => {
  test("assembleSynthesis produces topics in narrative order", () => {
    const chunks = [
      makeChunk("c1", "We deploy to production via Railway with Docker.", { timestamp: "2026-02-01T00:00:00Z" }),
      makeChunk("c2", "The system architecture uses event-driven design with adapters.", { timestamp: "2026-02-02T00:00:00Z" }),
      makeChunk("c3", "There's a bug causing errors in the handler, technical debt.", { timestamp: "2026-02-03T00:00:00Z" }),
    ];

    const groups = groupByTopic(chunks);
    const synthesis = assembleSynthesis(groups);

    // Should have 3 topics
    expect(synthesis.length).toBe(3);

    // Should be in narrative order: architecture before deployment before known-issues
    const topicOrder = synthesis.map((s) => s.topic);
    const archIdx = topicOrder.indexOf("architecture");
    const deployIdx = topicOrder.indexOf("deployment");
    const issuesIdx = topicOrder.indexOf("known-issues");
    expect(archIdx).toBeLessThan(deployIdx);
    expect(deployIdx).toBeLessThan(issuesIdx);
  });

  test("generateConversationFromSynthesis produces alternating user/assistant turns", () => {
    const chunks = [
      makeChunk("c1", "The system architecture uses event-driven design with adapters."),
      makeChunk("c2", "We deploy to production via Railway."),
    ];

    const groups = groupByTopic(chunks);
    const synthesis = assembleSynthesis(groups);
    const turns = generateConversationFromSynthesis(synthesis);

    // Each topic produces 2 turns (user + assistant)
    expect(turns.length).toBe(synthesis.length * 2);

    // Alternating roles
    for (let i = 0; i < turns.length; i++) {
      expect(turns[i].role).toBe(i % 2 === 0 ? "user" : "assistant");
    }
  });

  test("empty groups produce no synthesis", () => {
    const groups = new Map();
    const synthesis = assembleSynthesis(groups);
    expect(synthesis.length).toBe(0);
  });

  test("TOPIC_TAXONOMY has 9 topics", () => {
    expect(TOPIC_TAXONOMY.length).toBe(9);
  });

  test("NARRATIVE_ORDER covers all topics", () => {
    expect(NARRATIVE_ORDER.length).toBe(TOPIC_TAXONOMY.length);
    for (const topic of TOPIC_TAXONOMY) {
      expect(NARRATIVE_ORDER).toContain(topic);
    }
  });
});
