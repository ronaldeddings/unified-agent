/**
 * Defensive ClaudeMem wrapper with write-local-first semantics.
 *
 * All observations are written to a local `_sync_queue` SQLite table first,
 * then asynchronously synced to the ClaudeMem HTTP worker. If the worker is
 * offline, entries accumulate locally and are retried via `flushSyncQueue()`.
 */

import type { Database } from "bun:sqlite";
import type { ClaudeMemClient } from "./claudeMemClient.ts";
import type { Chunk } from "../scoring/chunker.ts";
import { newRequestId } from "../util/ids.ts";

/** Individual search result from ClaudeMem, normalized for the distillation pipeline. */
export interface ClaudeMemSearchResult {
  id: string;
  content: string;
  similarity: number;
  metadata?: Record<string, unknown>;
  createdAt?: string;
}

/** Row shape from the _sync_queue table. */
interface SyncQueueRow {
  id: number;
  operation: string;
  payload: string;
  created_at: string;
  synced_at: string | null;
}

export class DefensiveClaudeMemClient {
  private db: Database;
  private inner: ClaudeMemClient;

  constructor(inner: ClaudeMemClient, db: Database) {
    this.inner = inner;
    this.db = db;
  }

  /**
   * Store an observation with write-local-first semantics.
   *
   * 1. Write to local `_sync_queue` table immediately (always succeeds)
   * 2. Attempt HTTP POST to ClaudeMem worker
   * 3. If successful, mark queue entry as `synced_at = now()`
   * 4. If failed, leave in queue for background retry
   */
  async storeObservation(text: string): Promise<void> {
    const payload = JSON.stringify({ text, timestamp: new Date().toISOString() });

    // Step 1: Write to local queue (synchronous SQLite — always succeeds)
    const result = this.db
      .prepare("INSERT INTO _sync_queue (operation, payload) VALUES (?, ?)")
      .run("store_observation", payload);

    const rowId = Number(result.lastInsertRowid);

    // Step 2: Attempt to sync to ClaudeMem
    try {
      const ok = await this.inner.storeObservation({
        contentSessionId: "distill",
        cwd: process.cwd(),
        tool_name: "distill_observation",
        tool_input: { text },
        tool_response: { stored: true },
      });

      // Step 3: Mark synced on success
      if (ok) {
        this.db
          .prepare("UPDATE _sync_queue SET synced_at = datetime('now') WHERE id = ?")
          .run(rowId);
      }
    } catch {
      // Step 4: Failed — entry stays in queue for background retry
    }
  }

  /**
   * Retry all unsynced entries against the ClaudeMem HTTP worker.
   * Called periodically from the REPL event loop.
   */
  async flushSyncQueue(): Promise<void> {
    const unsynced = this.db
      .prepare("SELECT id, operation, payload FROM _sync_queue WHERE synced_at IS NULL ORDER BY id ASC")
      .all() as SyncQueueRow[];

    for (const row of unsynced) {
      try {
        const parsed = JSON.parse(row.payload) as { text: string };

        const ok = await this.inner.storeObservation({
          contentSessionId: "distill",
          cwd: process.cwd(),
          tool_name: "distill_observation",
          tool_input: { text: parsed.text },
          tool_response: { stored: true },
        });

        if (ok) {
          this.db
            .prepare("UPDATE _sync_queue SET synced_at = datetime('now') WHERE id = ?")
            .run(row.id);
        }
      } catch {
        // Individual entry failed — continue with remaining entries
      }
    }
  }

  /** Return the number of unsynced entries in the queue. */
  async getSyncQueueSize(): Promise<number> {
    const row = this.db
      .prepare("SELECT COUNT(*) as count FROM _sync_queue WHERE synced_at IS NULL")
      .get() as { count: number };
    return row.count;
  }

  /** Passthrough to inner ClaudeMem client. */
  async contextInject(projectPath: string): Promise<string> {
    const result = await this.inner.contextInject(projectPath);
    return result ?? "";
  }

  /**
   * Search ClaudeMem and return normalized individual results.
   *
   * The inner client returns a single `{ content: [...] }` object.
   * This method normalizes that into individual `ClaudeMemSearchResult` entries.
   */
  async search(query: string): Promise<ClaudeMemSearchResult[]> {
    try {
      const raw = await this.inner.search(query);

      if (raw.isError || !raw.content || raw.content.length === 0) {
        return [];
      }

      // Each content item is a text block — convert to individual results
      return raw.content.map((block, index) => ({
        id: `mem_${Date.now()}_${index}`,
        content: block.text,
        similarity: 1 - index * 0.05, // Approximate: results are ranked by relevance
        createdAt: new Date().toISOString(),
      }));
    } catch {
      return [];
    }
  }

  /**
   * Convert ClaudeMem search results into synthetic Chunk objects.
   *
   * 1. Calls `this.search(query)` to get semantic matches
   * 2. Maps each result to a Chunk with `id: "mem_" + result.id`, source marked as "claudemem"
   * 3. Derives `importanceAvg` from similarity score (0-1 → 0-100)
   * 4. Estimates tokens via `content.length / 4`
   * 5. Returns up to `maxResults` chunks (default: 20), compatible with assessment pipeline
   */
  async searchAsChunks(query: string, maxResults: number = 20): Promise<Chunk[]> {
    const results = await this.search(query);
    const limited = results.slice(0, maxResults);

    return limited.map((result, index) => ({
      id: `mem_${result.id}`,
      sessionId: "claudemem",
      events: [
        {
          type: "claudemem_result",
          role: "assistant" as const,
          content: result.content,
          timestamp: result.createdAt ?? new Date().toISOString(),
          metadata: {
            source: "claudemem",
            similarity: result.similarity,
          },
        },
      ],
      startIndex: index,
      endIndex: index,
      importanceAvg: Math.round(result.similarity * 100),
      tokenEstimate: Math.ceil(result.content.length / 4),
    }));
  }
}
