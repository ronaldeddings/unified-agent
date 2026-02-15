/**
 * Chunk builder — groups scored events into assessment-ready chunks.
 * Filters low-importance events, groups into windows, splits oversized chunks,
 * and adds overlap for context continuity.
 */

import type { ParsedEvent } from "../parsers/types.ts";
import { newRequestId } from "../util/ids.ts";
import { scoreEvent } from "./importance.ts";

export interface Chunk {
  id: string;
  sessionId: string;
  events: ParsedEvent[];
  startIndex: number;
  endIndex: number;
  importanceAvg: number;
  tokenEstimate: number;
}

export interface ChunkConfig {
  maxEventsPerChunk: number;      // Default: 20
  maxTokensPerChunk: number;      // Default: 4000
  minImportanceThreshold: number; // Default: 30
  overlapEvents: number;          // Default: 2
}

export const DEFAULT_CHUNK_CONFIG: ChunkConfig = {
  maxEventsPerChunk: 20,
  maxTokensPerChunk: 4000,
  minImportanceThreshold: 30,
  overlapEvents: 2,
};

/**
 * Rough token estimation: content.length / 4.
 */
export function estimateTokens(content: string): number {
  return Math.ceil(content.length / 4);
}

/** Compute the average importance score for a set of events. */
function computeImportanceAvg(events: ParsedEvent[]): number {
  if (events.length === 0) return 0;
  const total = events.reduce((sum, e) => {
    const score = (e.metadata?.importanceScore as number) ?? scoreEvent(e);
    return sum + score;
  }, 0);
  return Math.round((total / events.length) * 100) / 100;
}

/** Compute the total token estimate for a set of events. */
function computeTokenEstimate(events: ParsedEvent[]): number {
  return events.reduce((sum, e) => sum + estimateTokens(e.content), 0);
}

/** Scored event with its original index in the source array. */
interface ScoredItem {
  event: ParsedEvent;
  originalIndex: number;
  score: number;
}

/** Create a Chunk from a slice of events. */
function makeChunk(
  events: ParsedEvent[],
  sessionId: string,
  startIndex: number,
  endIndex: number,
): Chunk {
  return {
    id: newRequestId(),
    sessionId,
    events,
    startIndex,
    endIndex,
    importanceAvg: computeImportanceAvg(events),
    tokenEstimate: computeTokenEstimate(events),
  };
}

/** Split a window of scored events into chunks that each fit within the token budget. */
function splitByTokenBudget(
  scoredEvents: ScoredItem[],
  sessionId: string,
  maxTokens: number,
): Chunk[] {
  const chunks: Chunk[] = [];
  let currentBatch: ScoredItem[] = [];
  let currentTokens = 0;

  for (const item of scoredEvents) {
    const itemTokens = estimateTokens(item.event.content);

    if (currentTokens + itemTokens > maxTokens && currentBatch.length > 0) {
      chunks.push(makeChunk(
        currentBatch.map((s) => s.event),
        sessionId,
        currentBatch[0].originalIndex,
        currentBatch[currentBatch.length - 1].originalIndex,
      ));
      currentBatch = [];
      currentTokens = 0;
    }

    currentBatch.push(item);
    currentTokens += itemTokens;
  }

  if (currentBatch.length > 0) {
    chunks.push(makeChunk(
      currentBatch.map((s) => s.event),
      sessionId,
      currentBatch[0].originalIndex,
      currentBatch[currentBatch.length - 1].originalIndex,
    ));
  }

  return chunks;
}

/**
 * Build assessment-ready chunks from scored events.
 *
 * Pipeline:
 * 1. Filter events below minImportanceThreshold
 * 2. Group remaining events into windows of maxEventsPerChunk
 * 3. Estimate tokens per chunk
 * 4. Split chunks that exceed maxTokensPerChunk
 * 5. Add overlapEvents from previous chunk for context continuity
 */
export function buildChunks(
  events: ParsedEvent[],
  sessionId: string = "unknown",
  config?: Partial<ChunkConfig>,
): Chunk[] {
  const cfg: ChunkConfig = { ...DEFAULT_CHUNK_CONFIG, ...config };

  if (events.length === 0) return [];

  // Step 1: Score all events and filter below threshold
  const scored: ScoredItem[] = [];
  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    const score = (event.metadata?.importanceScore as number) ?? scoreEvent(event);
    if (score >= cfg.minImportanceThreshold) {
      scored.push({ event, originalIndex: i, score });
    }
  }

  if (scored.length === 0) return [];

  // Step 2: Group into windows of maxEventsPerChunk
  const windows: ScoredItem[][] = [];
  for (let i = 0; i < scored.length; i += cfg.maxEventsPerChunk) {
    windows.push(scored.slice(i, i + cfg.maxEventsPerChunk));
  }

  // Step 3 & 4: Build chunks, splitting those that exceed maxTokensPerChunk
  const rawChunks: Chunk[] = [];
  for (const window of windows) {
    const chunk = makeChunk(
      window.map((s) => s.event),
      sessionId,
      window[0].originalIndex,
      window[window.length - 1].originalIndex,
    );

    if (chunk.tokenEstimate <= cfg.maxTokensPerChunk) {
      rawChunks.push(chunk);
    } else {
      const subChunks = splitByTokenBudget(window, sessionId, cfg.maxTokensPerChunk);
      rawChunks.push(...subChunks);
    }
  }

  // Step 5: Add overlap from previous chunk
  if (cfg.overlapEvents > 0 && rawChunks.length > 1) {
    for (let i = 1; i < rawChunks.length; i++) {
      const prevEvents = rawChunks[i - 1].events;
      const overlapCount = Math.min(cfg.overlapEvents, prevEvents.length);
      const overlapSlice = prevEvents.slice(prevEvents.length - overlapCount);

      rawChunks[i].events = [...overlapSlice, ...rawChunks[i].events];
      if (rawChunks[i - 1].endIndex >= 0) {
        rawChunks[i].startIndex = Math.max(
          0,
          rawChunks[i - 1].endIndex - overlapCount + 1,
        );
      }
      rawChunks[i].importanceAvg = computeImportanceAvg(rawChunks[i].events);
      rawChunks[i].tokenEstimate = computeTokenEstimate(rawChunks[i].events);
    }
  }

  return rawChunks;
}
