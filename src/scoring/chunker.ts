/**
 * Chunk builder types and function signature.
 * Groups scored events into assessment-ready chunks.
 * Implementation will be added in Phase 3.
 */

import type { ParsedEvent } from "../parsers/types.ts";

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
 * Build assessment-ready chunks from scored events.
 * Implementation in Phase 3.
 */
export function buildChunks(
  _events: ParsedEvent[],
  _sessionId?: string,
  _config?: Partial<ChunkConfig>,
): Chunk[] {
  throw new Error("buildChunks() not yet implemented — Phase 3");
}

/**
 * Rough token estimation: content.length / 4.
 */
export function estimateTokens(content: string): number {
  return Math.ceil(content.length / 4);
}
