/**
 * Integration test: defensive mem offline/online sync.
 * Item 88: Store 5 observations with ClaudeMem offline, verify sync queue has 5 entries,
 * flush after online, verify queue is empty.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";

import { DefensiveClaudeMemClient } from "../src/memory/defensiveMem.ts";
import { runDistillMigrations } from "../src/storage/distillMigrations.ts";
import type { ClaudeMemClient } from "../src/memory/claudeMemClient.ts";

/**
 * Mock ClaudeMemClient that can simulate offline/online states.
 */
class MockClaudeMemClient {
  online = false;
  storedObservations: unknown[] = [];

  async health(): Promise<boolean> {
    return this.online;
  }

  async contextInject(_project: string): Promise<string | null> {
    return this.online ? "mock context" : null;
  }

  async search(_query: string): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
    if (!this.online) {
      return { content: [], isError: true };
    }
    return {
      content: [{ type: "text" as const, text: "mock search result" }],
    };
  }

  async stats(): Promise<unknown | null> {
    return this.online ? { count: this.storedObservations.length } : null;
  }

  async storeObservation(args: {
    contentSessionId: string;
    cwd: string;
    tool_name: string;
    tool_input: unknown;
    tool_response: unknown;
  }): Promise<boolean> {
    if (!this.online) {
      throw new Error("Connection refused — ClaudeMem worker offline");
    }
    this.storedObservations.push(args);
    return true;
  }
}

let db: Database;
let mockClient: MockClaudeMemClient;
let defensiveMem: DefensiveClaudeMemClient;

beforeEach(() => {
  // In-memory SQLite for test isolation
  db = new Database(":memory:");

  // Create required tables
  db.run(`
    CREATE TABLE IF NOT EXISTS meta_sessions (
      id TEXT PRIMARY KEY
    );
  `);
  runDistillMigrations(db);

  mockClient = new MockClaudeMemClient();
  defensiveMem = new DefensiveClaudeMemClient(
    mockClient as unknown as ClaudeMemClient,
    db,
  );
});

afterEach(() => {
  db.close();
});

describe("Item 88: Defensive mem offline/online sync", () => {
  test("store 5 observations offline → queue has 5 → flush online → queue empty", async () => {
    // Phase 1: ClaudeMem is OFFLINE
    mockClient.online = false;

    // Store 5 observations while offline
    for (let i = 0; i < 5; i++) {
      await defensiveMem.storeObservation(`Test observation ${i + 1}: important finding about the codebase`);
    }

    // Verify: sync queue should have 5 unsynced entries
    const queueSizeAfterStore = await defensiveMem.getSyncQueueSize();
    expect(queueSizeAfterStore).toBe(5);

    // Verify: none should be marked as synced
    const unsyncedRows = db
      .prepare("SELECT COUNT(*) as count FROM _sync_queue WHERE synced_at IS NULL")
      .get() as { count: number };
    expect(unsyncedRows.count).toBe(5);

    // Verify: total rows should be 5
    const totalRows = db
      .prepare("SELECT COUNT(*) as count FROM _sync_queue")
      .get() as { count: number };
    expect(totalRows.count).toBe(5);

    // Phase 2: Bring ClaudeMem ONLINE
    mockClient.online = true;

    // Flush the sync queue
    await defensiveMem.flushSyncQueue();

    // Verify: sync queue should be empty (all synced)
    const queueSizeAfterFlush = await defensiveMem.getSyncQueueSize();
    expect(queueSizeAfterFlush).toBe(0);

    // Verify: all 5 entries should now have synced_at set
    const syncedRows = db
      .prepare("SELECT COUNT(*) as count FROM _sync_queue WHERE synced_at IS NOT NULL")
      .get() as { count: number };
    expect(syncedRows.count).toBe(5);

    // Verify: mock client received all 5 observations
    expect(mockClient.storedObservations.length).toBe(5);
  });

  test("partial sync — some fail, some succeed on flush", async () => {
    mockClient.online = false;

    // Store 3 observations while offline
    for (let i = 0; i < 3; i++) {
      await defensiveMem.storeObservation(`Observation ${i + 1}`);
    }

    expect(await defensiveMem.getSyncQueueSize()).toBe(3);

    // Bring online but make it fail after 2 successful syncs
    let syncCount = 0;
    const originalStore = mockClient.storeObservation.bind(mockClient);
    mockClient.storeObservation = async (args) => {
      syncCount++;
      if (syncCount > 2) {
        throw new Error("Intermittent failure");
      }
      return originalStore(args);
    };
    mockClient.online = true;

    await defensiveMem.flushSyncQueue();

    // 1 should remain unsynced (the 3rd one failed)
    const remaining = await defensiveMem.getSyncQueueSize();
    expect(remaining).toBe(1);

    // 2 should be synced
    const synced = db
      .prepare("SELECT COUNT(*) as count FROM _sync_queue WHERE synced_at IS NOT NULL")
      .get() as { count: number };
    expect(synced.count).toBe(2);
  });

  test("storeObservation syncs immediately when online", async () => {
    mockClient.online = true;

    await defensiveMem.storeObservation("Immediate sync observation");

    // Queue should be empty (synced immediately)
    const queueSize = await defensiveMem.getSyncQueueSize();
    expect(queueSize).toBe(0);

    // Mock client should have received it
    expect(mockClient.storedObservations.length).toBe(1);

    // Row should exist with synced_at set
    const total = db
      .prepare("SELECT COUNT(*) as count FROM _sync_queue")
      .get() as { count: number };
    expect(total.count).toBe(1);

    const synced = db
      .prepare("SELECT COUNT(*) as count FROM _sync_queue WHERE synced_at IS NOT NULL")
      .get() as { count: number };
    expect(synced.count).toBe(1);
  });
});
