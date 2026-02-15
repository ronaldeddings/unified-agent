import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { ClaudeMemClient } from "../src/memory/claudeMemClient.ts";
import { DefensiveClaudeMemClient } from "../src/memory/defensiveMem.ts";
import { runDistillMigrations } from "../src/storage/distillMigrations.ts";

/** Create a temporary in-memory-like SQLite DB with the _sync_queue table. */
function createTestDb(dir: string): Database {
  const db = new Database(join(dir, "test.sqlite"));
  db.run("PRAGMA journal_mode = WAL;");
  // Create the minimal schema needed — _sync_queue from distill migrations
  runDistillMigrations(db);
  return db;
}

/** Create a mock ClaudeMemClient with controllable fetch behavior. */
function createMockClient(fetchFn: typeof fetch): ClaudeMemClient {
  return new ClaudeMemClient("http://mock-claudemem:37777", fetchFn);
}

describe("DefensiveClaudeMemClient", () => {
  let dir: string;
  let db: Database;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "defensive-mem-test-"));
    db = createTestDb(dir);
  });

  afterEach(() => {
    db.close();
  });

  describe("storeObservation", () => {
    test("writes to _sync_queue even when ClaudeMem is offline", async () => {
      const inner = createMockClient(async () => {
        throw new Error("connection refused");
      });
      const client = new DefensiveClaudeMemClient(inner, db);

      await client.storeObservation("test observation about code");

      // Entry should be in the queue
      const size = await client.getSyncQueueSize();
      expect(size).toBe(1);

      // Entry should NOT be synced
      const row = db
        .prepare("SELECT * FROM _sync_queue WHERE synced_at IS NULL")
        .get() as { operation: string; payload: string } | null;
      expect(row).not.toBeNull();
      expect(row!.operation).toBe("store_observation");
      const payload = JSON.parse(row!.payload) as { text: string };
      expect(payload.text).toBe("test observation about code");
    });

    test("marks entry as synced when ClaudeMem succeeds", async () => {
      const inner = createMockClient(async (url, init) => {
        const urlStr = String(url);
        if (urlStr.includes("/api/sessions/observations") && init?.method === "POST") {
          return new Response("ok", { status: 200 });
        }
        return new Response("not found", { status: 404 });
      });
      const client = new DefensiveClaudeMemClient(inner, db);

      await client.storeObservation("synced observation");

      // Entry should exist but be synced
      const unsynced = await client.getSyncQueueSize();
      expect(unsynced).toBe(0);

      // Verify the row exists with synced_at set
      const row = db
        .prepare("SELECT synced_at FROM _sync_queue ORDER BY id DESC LIMIT 1")
        .get() as { synced_at: string | null } | null;
      expect(row).not.toBeNull();
      expect(row!.synced_at).not.toBeNull();
    });

    test("leaves entry unsynced when ClaudeMem returns non-ok", async () => {
      const inner = createMockClient(async (url, init) => {
        const urlStr = String(url);
        if (urlStr.includes("/api/sessions/observations")) {
          return new Response("server error", { status: 500 });
        }
        return new Response("not found", { status: 404 });
      });
      const client = new DefensiveClaudeMemClient(inner, db);

      await client.storeObservation("failed observation");

      const size = await client.getSyncQueueSize();
      expect(size).toBe(1);
    });

    test("stores multiple observations independently", async () => {
      const inner = createMockClient(async () => {
        throw new Error("offline");
      });
      const client = new DefensiveClaudeMemClient(inner, db);

      await client.storeObservation("first");
      await client.storeObservation("second");
      await client.storeObservation("third");

      const size = await client.getSyncQueueSize();
      expect(size).toBe(3);
    });
  });

  describe("flushSyncQueue", () => {
    test("retries and syncs previously failed entries", async () => {
      let callCount = 0;
      const inner = createMockClient(async (url, init) => {
        const urlStr = String(url);
        if (urlStr.includes("/api/sessions/observations")) {
          callCount++;
          // First call fails (during storeObservation), second succeeds (during flush)
          if (callCount <= 1) {
            return new Response("error", { status: 500 });
          }
          return new Response("ok", { status: 200 });
        }
        return new Response("not found", { status: 404 });
      });
      const client = new DefensiveClaudeMemClient(inner, db);

      // Store — will fail sync
      await client.storeObservation("retry me");
      expect(await client.getSyncQueueSize()).toBe(1);

      // Flush — should succeed now
      await client.flushSyncQueue();
      expect(await client.getSyncQueueSize()).toBe(0);
    });

    test("handles partial flush — some succeed, some fail", async () => {
      let callCount = 0;
      const inner = createMockClient(async (url, init) => {
        const urlStr = String(url);
        if (urlStr.includes("/api/sessions/observations")) {
          callCount++;
          // During store: all fail (calls 1-3)
          // During flush: first succeeds (4), second fails (5), third succeeds (6)
          if (callCount <= 3) return new Response("error", { status: 500 });
          if (callCount === 5) return new Response("error", { status: 500 });
          return new Response("ok", { status: 200 });
        }
        return new Response("not found", { status: 404 });
      });
      const client = new DefensiveClaudeMemClient(inner, db);

      await client.storeObservation("entry-1");
      await client.storeObservation("entry-2");
      await client.storeObservation("entry-3");
      expect(await client.getSyncQueueSize()).toBe(3);

      await client.flushSyncQueue();
      // entry-2 still failed, others synced
      expect(await client.getSyncQueueSize()).toBe(1);
    });

    test("no-op when queue is empty", async () => {
      const inner = createMockClient(async () => {
        throw new Error("should not be called");
      });
      const client = new DefensiveClaudeMemClient(inner, db);

      // Should not throw
      await client.flushSyncQueue();
      expect(await client.getSyncQueueSize()).toBe(0);
    });

    test("continues processing when individual entry throws", async () => {
      const inner = createMockClient(async () => {
        throw new Error("offline");
      });
      const client = new DefensiveClaudeMemClient(inner, db);

      await client.storeObservation("a");
      await client.storeObservation("b");

      // Flush — both will fail but should not throw
      await client.flushSyncQueue();
      expect(await client.getSyncQueueSize()).toBe(2);
    });
  });

  describe("getSyncQueueSize", () => {
    test("returns 0 for empty queue", async () => {
      const inner = createMockClient(async () => new Response("ok", { status: 200 }));
      const client = new DefensiveClaudeMemClient(inner, db);

      expect(await client.getSyncQueueSize()).toBe(0);
    });

    test("excludes synced entries from count", async () => {
      const inner = createMockClient(async (url) => {
        const urlStr = String(url);
        if (urlStr.includes("/api/sessions/observations")) {
          return new Response("ok", { status: 200 });
        }
        return new Response("not found", { status: 404 });
      });
      const client = new DefensiveClaudeMemClient(inner, db);

      await client.storeObservation("synced one");
      expect(await client.getSyncQueueSize()).toBe(0); // Already synced
    });
  });

  describe("contextInject", () => {
    test("returns context from inner client", async () => {
      const inner = createMockClient(async (url) => {
        const urlStr = String(url);
        if (urlStr.includes("/api/context/inject")) {
          return new Response("## Project Context\nRelevant info here", { status: 200 });
        }
        return new Response("not found", { status: 404 });
      });
      const client = new DefensiveClaudeMemClient(inner, db);

      const result = await client.contextInject("test-project");
      expect(result).toBe("## Project Context\nRelevant info here");
    });

    test("returns empty string when inner client returns null", async () => {
      const inner = createMockClient(async () => {
        return new Response("error", { status: 500 });
      });
      const client = new DefensiveClaudeMemClient(inner, db);

      const result = await client.contextInject("bad-project");
      expect(result).toBe("");
    });
  });

  describe("search", () => {
    test("returns normalized results from inner search", async () => {
      const inner = createMockClient(async (url) => {
        const urlStr = String(url);
        if (urlStr.includes("/api/search")) {
          return new Response(
            JSON.stringify({
              content: [
                { type: "text", text: "First result about TypeScript" },
                { type: "text", text: "Second result about testing" },
              ],
              isError: false,
            }),
            { status: 200 }
          );
        }
        return new Response("not found", { status: 404 });
      });
      const client = new DefensiveClaudeMemClient(inner, db);

      const results = await client.search("TypeScript");
      expect(results.length).toBe(2);
      expect(results[0].content).toBe("First result about TypeScript");
      expect(results[0].similarity).toBeGreaterThan(0);
      expect(results[0].id).toContain("mem_");
      expect(results[1].content).toBe("Second result about testing");
      // Second result should have lower similarity (ranked by index)
      expect(results[1].similarity).toBeLessThan(results[0].similarity);
    });

    test("returns empty array when search fails", async () => {
      const inner = createMockClient(async () => {
        throw new Error("network error");
      });
      const client = new DefensiveClaudeMemClient(inner, db);

      const results = await client.search("anything");
      expect(results).toEqual([]);
    });

    test("returns empty array when search returns error response", async () => {
      const inner = createMockClient(async (url) => {
        const urlStr = String(url);
        if (urlStr.includes("/api/search")) {
          return new Response(
            JSON.stringify({
              content: [{ type: "text", text: "claude-mem search failed: 500" }],
              isError: true,
            }),
            { status: 200 }
          );
        }
        return new Response("not found", { status: 404 });
      });
      const client = new DefensiveClaudeMemClient(inner, db);

      const results = await client.search("query");
      expect(results).toEqual([]);
    });
  });

  describe("searchAsChunks", () => {
    test("converts search results to Chunk objects", async () => {
      const inner = createMockClient(async (url) => {
        const urlStr = String(url);
        if (urlStr.includes("/api/search")) {
          return new Response(
            JSON.stringify({
              content: [
                { type: "text", text: "A chunk about React hooks and state management" },
                { type: "text", text: "Another chunk about testing patterns" },
              ],
              isError: false,
            }),
            { status: 200 }
          );
        }
        return new Response("not found", { status: 404 });
      });
      const client = new DefensiveClaudeMemClient(inner, db);

      const chunks = await client.searchAsChunks("React hooks");
      expect(chunks.length).toBe(2);

      // First chunk
      expect(chunks[0].id).toContain("mem_");
      expect(chunks[0].sessionId).toBe("claudemem");
      expect(chunks[0].events.length).toBe(1);
      expect(chunks[0].events[0].content).toBe("A chunk about React hooks and state management");
      expect(chunks[0].events[0].type).toBe("claudemem_result");
      expect(chunks[0].events[0].role).toBe("assistant");
      expect(chunks[0].importanceAvg).toBeGreaterThan(0);
      expect(chunks[0].importanceAvg).toBeLessThanOrEqual(100);
      expect(chunks[0].tokenEstimate).toBe(Math.ceil("A chunk about React hooks and state management".length / 4));
      expect(chunks[0].startIndex).toBe(0);
      expect(chunks[0].endIndex).toBe(0);

      // Second chunk
      expect(chunks[1].startIndex).toBe(1);
      expect(chunks[1].endIndex).toBe(1);
    });

    test("respects maxResults parameter", async () => {
      const inner = createMockClient(async (url) => {
        const urlStr = String(url);
        if (urlStr.includes("/api/search")) {
          return new Response(
            JSON.stringify({
              content: [
                { type: "text", text: "Result 1" },
                { type: "text", text: "Result 2" },
                { type: "text", text: "Result 3" },
                { type: "text", text: "Result 4" },
                { type: "text", text: "Result 5" },
              ],
              isError: false,
            }),
            { status: 200 }
          );
        }
        return new Response("not found", { status: 404 });
      });
      const client = new DefensiveClaudeMemClient(inner, db);

      const chunks = await client.searchAsChunks("query", 2);
      expect(chunks.length).toBe(2);
    });

    test("returns empty array when search fails", async () => {
      const inner = createMockClient(async () => {
        throw new Error("offline");
      });
      const client = new DefensiveClaudeMemClient(inner, db);

      const chunks = await client.searchAsChunks("anything");
      expect(chunks).toEqual([]);
    });

    test("derives importanceAvg from similarity score (0-1 → 0-100)", async () => {
      const inner = createMockClient(async (url) => {
        const urlStr = String(url);
        if (urlStr.includes("/api/search")) {
          return new Response(
            JSON.stringify({
              content: [{ type: "text", text: "High relevance result" }],
              isError: false,
            }),
            { status: 200 }
          );
        }
        return new Response("not found", { status: 404 });
      });
      const client = new DefensiveClaudeMemClient(inner, db);

      const chunks = await client.searchAsChunks("exact match");
      expect(chunks.length).toBe(1);
      // First result gets similarity ~1.0, so importanceAvg should be ~100
      expect(chunks[0].importanceAvg).toBe(100);
    });
  });
});
