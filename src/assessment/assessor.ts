/**
 * Multi-agent assessment types and function signatures.
 * Implementation will be added in Phase 4.
 */

import type { Chunk } from "../scoring/chunker.ts";

export interface AssessmentResult {
  provider: "claude" | "codex" | "gemini";
  chunkId: string;
  score: number;        // 1-10
  rationale: string;
  model?: string;
  tokensUsed?: number;
  latencyMs: number;
}

export interface AssessorConfig {
  providers: ("claude" | "codex" | "gemini")[];  // Default: all three
  timeoutMs: number;                              // Default: 30000
  maxConcurrent: number;                          // Default: 3
  retryOnFailure: boolean;                        // Default: true
}

export const DEFAULT_ASSESSOR_CONFIG: AssessorConfig = {
  providers: ["claude", "codex", "gemini"],
  timeoutMs: 30000,
  maxConcurrent: 3,
  retryOnFailure: true,
};

/**
 * Assess a single chunk using multiple providers.
 * Implementation in Phase 4.
 */
export async function assessChunk(
  _chunk: Chunk,
  _config?: Partial<AssessorConfig>,
): Promise<AssessmentResult[]> {
  throw new Error("assessChunk() not yet implemented — Phase 4");
}

/**
 * Assess multiple chunks with parallel execution and progress reporting.
 * Implementation in Phase 4.
 */
export async function assessChunks(
  _chunks: Chunk[],
  _config?: Partial<AssessorConfig>,
  _onProgress?: (completed: number, total: number) => void,
): Promise<Map<string, AssessmentResult[]>> {
  throw new Error("assessChunks() not yet implemented — Phase 4");
}
