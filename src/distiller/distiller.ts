/**
 * Token-budget distiller types and function signature.
 * Selects the highest-value chunks that fit within a token budget.
 * Implementation will be added in Phase 5.
 */

import type { Chunk } from "../scoring/chunker.ts";

export interface DistillerConfig {
  maxTokens: number;              // Default: 80000
  minConsensusScore: number;      // Default: 5.0
  includeSystemContext: boolean;  // Default: true
  sortBy: "consensus" | "chronological" | "hybrid";  // Default: "hybrid"
}

export const DEFAULT_DISTILLER_CONFIG: DistillerConfig = {
  maxTokens: 80000,
  minConsensusScore: 5.0,
  includeSystemContext: true,
  sortBy: "hybrid",
};

export interface DistilledSession {
  sourceSessionIds: string[];
  sourcePlatforms: string[];
  chunks: Chunk[];
  totalTokens: number;
  droppedChunks: number;
  distilledAt: string;
}

/**
 * Select the highest-value chunks within a token budget.
 * Implementation in Phase 5.
 */
export function distill(
  _scoredChunks: Map<string, { chunk: Chunk; consensus: number }>,
  _config?: Partial<DistillerConfig>,
): DistilledSession {
  throw new Error("distill() not yet implemented — Phase 5");
}
