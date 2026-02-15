/**
 * Backpressure-aware assessment queue.
 *
 * Manages concurrent chunk assessments with configurable concurrency limits.
 * When more chunks are submitted than can be assessed concurrently, excess
 * work is queued and processed as slots become available.
 */

import type { Chunk } from "../scoring/chunker.ts";
import type { AssessmentResult } from "../assessment/assessor.ts";
import { assessChunk } from "../assessment/assessor.ts";

export interface QueueConfig {
  /** Maximum concurrent assessments. Default: 3. */
  maxConcurrent: number;
  /** Per-assessment timeout in ms. Default: 30000. */
  timeoutMs: number;
  /** Providers to use for assessment. */
  providers: ("claude" | "codex" | "gemini")[];
}

const DEFAULT_QUEUE_CONFIG: QueueConfig = {
  maxConcurrent: 3,
  timeoutMs: 30000,
  providers: ["claude", "codex", "gemini"],
};

interface QueueItem {
  chunk: Chunk;
  resolve: (results: AssessmentResult[]) => void;
  reject: (error: Error) => void;
}

export class AssessmentQueue {
  private config: QueueConfig;
  private queue: QueueItem[] = [];
  private inFlight = 0;
  private totalCompleted = 0;
  private totalFailed = 0;

  constructor(config?: Partial<QueueConfig>) {
    this.config = { ...DEFAULT_QUEUE_CONFIG, ...config };
  }

  /** Number of assessments currently in progress. */
  get activeCount(): number {
    return this.inFlight;
  }

  /** Number of assessments waiting in the queue. */
  get pendingCount(): number {
    return this.queue.length;
  }

  /** Whether the queue is at capacity. */
  get isAtCapacity(): boolean {
    return this.inFlight >= this.config.maxConcurrent;
  }

  /** Total assessments completed since creation. */
  get completedCount(): number {
    return this.totalCompleted;
  }

  /** Total assessments that failed since creation. */
  get failedCount(): number {
    return this.totalFailed;
  }

  /**
   * Submit a chunk for assessment. Returns a promise that resolves with the
   * assessment results. If the queue is at capacity, the chunk will be queued
   * and processed when a slot becomes available.
   */
  enqueue(chunk: Chunk): Promise<AssessmentResult[]> {
    return new Promise<AssessmentResult[]>((resolve, reject) => {
      this.queue.push({ chunk, resolve, reject });
      this.drain();
    });
  }

  /**
   * Submit multiple chunks. Returns results as a map from chunk ID to results.
   */
  async enqueueMany(chunks: Chunk[]): Promise<Map<string, AssessmentResult[]>> {
    const results = new Map<string, AssessmentResult[]>();
    const promises = chunks.map(async (chunk) => {
      const res = await this.enqueue(chunk);
      results.set(chunk.id, res);
    });
    await Promise.all(promises);
    return results;
  }

  /** Get queue status for reporting. */
  status(): {
    active: number;
    pending: number;
    completed: number;
    failed: number;
    maxConcurrent: number;
  } {
    return {
      active: this.inFlight,
      pending: this.queue.length,
      completed: this.totalCompleted,
      failed: this.totalFailed,
      maxConcurrent: this.config.maxConcurrent,
    };
  }

  /** Process items from the queue up to concurrency limit. */
  private drain(): void {
    while (this.inFlight < this.config.maxConcurrent && this.queue.length > 0) {
      const item = this.queue.shift();
      if (!item) break;
      this.inFlight++;
      this.processItem(item);
    }
  }

  /** Process a single queue item. */
  private async processItem(item: QueueItem): Promise<void> {
    try {
      const results = await assessChunk(item.chunk, {
        providers: this.config.providers,
        timeoutMs: this.config.timeoutMs,
      });
      this.totalCompleted++;
      item.resolve(results);
    } catch (err) {
      this.totalFailed++;
      item.reject(err instanceof Error ? err : new Error(String(err)));
    } finally {
      this.inFlight--;
      this.drain();
    }
  }
}
