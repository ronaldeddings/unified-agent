import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { ClaudeMemClient } from "../src/memory/claudeMemClient.ts";
import { DefensiveClaudeMemClient } from "../src/memory/defensiveMem.ts";
import { runDistillMigrations } from "../src/storage/distillMigrations.ts";

/** Create a temporary SQLite DB with distill migrations. */
function createTestDb(dir: string): Database {
  const db = new Database(join(dir, "test.sqlite"));
  db.run("PRAGMA journal_mode = WAL;");
  runDistillMigrations(db);
  return db;
}

/** Create a mock ClaudeMemClient with a controllable fetch. */
function createMockClient(fetchFn: typeof fetch): ClaudeMemClient {
  return new ClaudeMemClient("http://mock-claudemem:37777", fetchFn);
}

describe("DefensiveClaudeMemClient.searchAsChunks", () => {
  let dir: string;
  let db: Database;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "search-chunks-test-"));
    db = createTestDb(dir);
  });

  afterEach(() => {
    db.close();
  });

  test("converts ClaudeMem search results to Chunk objects", async () => {
    const mockFetch = async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/search")) {
        return new Response(
          JSON.stringify({
            content: [
              { type: "text", text: "The adapter pattern normalizes events across providers" },
              { type: "text", text: "Each provider has a different JSONL format" },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 200 });
    };

    const inner = createMockClient(mockFetch);
    const client = new DefensiveClaudeMemClient(inner, db);

    const chunks = await client.searchAsChunks("adapter pattern");

    expect(chunks.length).toBe(2);

    // Check first chunk structure
    const first = chunks[0];
    expect(first.id).toContain("mem_");
    expect(first.sessionId).toBe("claudemem");
    expect(first.events.length).toBe(1);
    expect(first.events[0].type).toBe("claudemem_result");
    expect(first.events[0].role).toBe("assistant");
    expect(first.events[0].content).toContain("adapter pattern normalizes");
    expect(first.events[0].metadata?.source).toBe("claudemem");
    expect(typeof first.events[0].metadata?.similarity).toBe("number");

    // Check importance derived from similarity
    expect(first.importanceAvg).toBeGreaterThan(0);
    expect(first.importanceAvg).toBeLessThanOrEqual(100);

    // Check token estimate
    expect(first.tokenEstimate).toBeGreaterThan(0);
    expect(first.tokenEstimate).toBe(
      Math.ceil(first.events[0].content.length / 4),
    );
  });

  test("returns empty array when ClaudeMem returns no results", async () => {
    const mockFetch = async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/search")) {
        return new Response(
          JSON.stringify({ content: [] }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 200 });
    };

    const inner = createMockClient(mockFetch);
    const client = new DefensiveClaudeMemClient(inner, db);

    const chunks = await client.searchAsChunks("nonexistent topic");
    expect(chunks).toEqual([]);
  });

  test("returns empty array when ClaudeMem returns error", async () => {
    const mockFetch = async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/search")) {
        return new Response(
          JSON.stringify({ isError: true, content: [] }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 200 });
    };

    const inner = createMockClient(mockFetch);
    const client = new DefensiveClaudeMemClient(inner, db);

    const chunks = await client.searchAsChunks("any query");
    expect(chunks).toEqual([]);
  });

  test("returns empty array when ClaudeMem is offline", async () => {
    const inner = createMockClient(async () => {
      throw new Error("connection refused");
    });
    const client = new DefensiveClaudeMemClient(inner, db);

    const chunks = await client.searchAsChunks("any query");
    expect(chunks).toEqual([]);
  });

  test("respects maxResults parameter", async () => {
    const mockFetch = async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/search")) {
        return new Response(
          JSON.stringify({
            content: [
              { type: "text", text: "Result 1" },
              { type: "text", text: "Result 2" },
              { type: "text", text: "Result 3" },
              { type: "text", text: "Result 4" },
              { type: "text", text: "Result 5" },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 200 });
    };

    const inner = createMockClient(mockFetch);
    const client = new DefensiveClaudeMemClient(inner, db);

    const chunks = await client.searchAsChunks("test", 3);
    expect(chunks.length).toBe(3);
  });

  test("assigns decreasing importance based on result order", async () => {
    const mockFetch = async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/search")) {
        return new Response(
          JSON.stringify({
            content: [
              { type: "text", text: "Most relevant result" },
              { type: "text", text: "Second most relevant" },
              { type: "text", text: "Third most relevant" },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 200 });
    };

    const inner = createMockClient(mockFetch);
    const client = new DefensiveClaudeMemClient(inner, db);

    const chunks = await client.searchAsChunks("relevance test");
    expect(chunks.length).toBe(3);

    // First result should have higher importance than later ones
    expect(chunks[0].importanceAvg).toBeGreaterThanOrEqual(chunks[1].importanceAvg);
    expect(chunks[1].importanceAvg).toBeGreaterThanOrEqual(chunks[2].importanceAvg);
  });

  test("sets sequential startIndex and endIndex", async () => {
    const mockFetch = async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/search")) {
        return new Response(
          JSON.stringify({
            content: [
              { type: "text", text: "First" },
              { type: "text", text: "Second" },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 200 });
    };

    const inner = createMockClient(mockFetch);
    const client = new DefensiveClaudeMemClient(inner, db);

    const chunks = await client.searchAsChunks("test");
    expect(chunks[0].startIndex).toBe(0);
    expect(chunks[0].endIndex).toBe(0);
    expect(chunks[1].startIndex).toBe(1);
    expect(chunks[1].endIndex).toBe(1);
  });
});
