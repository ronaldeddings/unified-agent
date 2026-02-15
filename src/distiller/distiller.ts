/**
 * Token-budget distiller — selects the highest-value chunks
 * that fit within a token budget. Supports consensus, chronological,
 * and hybrid sort modes.
 */

import type { Chunk } from "../scoring/chunker.ts";

export interface DistillerConfig {
  maxTokens: number;              // Default: 80000
  minConsensusScore: number;      // Default: 5.0
  includeSystemContext: boolean;  // Default: true
  sortBy: "consensus" | "chronological" | "hybrid";  // Default: "hybrid"
  hybridConsensusWeight: number;  // Default: 0.7
  hybridRecencyWeight: number;    // Default: 0.3
}

export const DEFAULT_DISTILLER_CONFIG: DistillerConfig = {
  maxTokens: 80000,
  minConsensusScore: 5.0,
  includeSystemContext: true,
  sortBy: "hybrid",
  hybridConsensusWeight: 0.7,
  hybridRecencyWeight: 0.3,
};

export interface DistilledSession {
  sourceSessionIds: string[];
  sourcePlatforms: string[];
  chunks: Chunk[];
  totalTokens: number;
  droppedChunks: number;
  distilledAt: string;
}

interface ScoredEntry {
  chunk: Chunk;
  consensus: number;
  sortScore: number;
}

/**
 * Normalize a value into 0-1 range given min/max bounds.
 * Returns 0 if min === max (all values identical).
 */
function normalize(value: number, min: number, max: number): number {
  if (max === min) return 0;
  return (value - min) / (max - min);
}

/**
 * Compute hybrid sort score: weighted combination of normalized consensus
 * and normalized recency (index position / total).
 */
function computeHybridScore(
  consensus: number,
  index: number,
  total: number,
  minConsensus: number,
  maxConsensus: number,
  consensusWeight: number,
  recencyWeight: number,
): number {
  const normalizedConsensus = normalize(consensus, minConsensus, maxConsensus);
  const normalizedRecency = total > 1 ? index / (total - 1) : 0;
  return consensusWeight * normalizedConsensus + recencyWeight * normalizedRecency;
}

/**
 * Select the highest-value chunks within a token budget.
 *
 * Pipeline:
 * 1. Filter chunks below minConsensusScore
 * 2. Sort by selected mode (consensus, chronological, or hybrid)
 * 3. Greedily select top chunks until token budget is exhausted
 * 4. Re-sort selected chunks chronologically for output coherence
 */
export function distill(
  scoredChunks: Map<string, { chunk: Chunk; consensus: number }>,
  config?: Partial<DistillerConfig>,
): DistilledSession {
  const cfg: DistillerConfig = { ...DEFAULT_DISTILLER_CONFIG, ...config };

  // Step 1: Filter by minimum consensus score
  const entries: ScoredEntry[] = [];
  for (const [, { chunk, consensus }] of scoredChunks) {
    if (consensus >= cfg.minConsensusScore) {
      entries.push({ chunk, consensus, sortScore: 0 });
    }
  }

  const droppedByConsensus = scoredChunks.size - entries.length;

  // Step 2: Sort by selected mode
  if (cfg.sortBy === "consensus") {
    for (const entry of entries) {
      entry.sortScore = entry.consensus;
    }
    entries.sort((a, b) => b.sortScore - a.sortScore);
  } else if (cfg.sortBy === "chronological") {
    // Sort by startIndex ascending — later entries are "more recent"
    // For selection, we want most recent first, so sort descending
    for (const entry of entries) {
      entry.sortScore = entry.chunk.startIndex;
    }
    entries.sort((a, b) => b.sortScore - a.sortScore);
  } else {
    // Hybrid: 0.7 * normalizedConsensus + 0.3 * normalizedRecency
    const consensusValues = entries.map((e) => e.consensus);
    const minConsensus = Math.min(...consensusValues);
    const maxConsensus = Math.max(...consensusValues);

    // Assign chronological index based on startIndex order
    const sorted = [...entries].sort((a, b) => a.chunk.startIndex - b.chunk.startIndex);
    const indexMap = new Map<string, number>();
    for (let i = 0; i < sorted.length; i++) {
      indexMap.set(sorted[i].chunk.id, i);
    }

    for (const entry of entries) {
      const chronoIndex = indexMap.get(entry.chunk.id) ?? 0;
      entry.sortScore = computeHybridScore(
        entry.consensus,
        chronoIndex,
        entries.length,
        minConsensus,
        maxConsensus,
        cfg.hybridConsensusWeight,
        cfg.hybridRecencyWeight,
      );
    }
    entries.sort((a, b) => b.sortScore - a.sortScore);
  }

  // Step 3: Greedily select within token budget
  const selected: ScoredEntry[] = [];
  let totalTokens = 0;
  let droppedByBudget = 0;

  for (const entry of entries) {
    if (totalTokens + entry.chunk.tokenEstimate <= cfg.maxTokens) {
      selected.push(entry);
      totalTokens += entry.chunk.tokenEstimate;
    } else {
      droppedByBudget++;
    }
  }

  // Step 4: Re-sort selected chunks chronologically for output coherence
  selected.sort((a, b) => a.chunk.startIndex - b.chunk.startIndex);

  // Collect unique session IDs and platforms
  const sessionIds = new Set<string>();
  const platforms = new Set<string>();
  for (const { chunk } of selected) {
    sessionIds.add(chunk.sessionId);
    // Derive platform from sessionId prefix or metadata if available
    const platform = (chunk.events[0]?.metadata?.platform as string) ?? "unknown";
    if (platform !== "unknown") platforms.add(platform);
  }

  return {
    sourceSessionIds: [...sessionIds],
    sourcePlatforms: [...platforms],
    chunks: selected.map((e) => e.chunk),
    totalTokens,
    droppedChunks: droppedByConsensus + droppedByBudget,
    distilledAt: new Date().toISOString(),
  };
}
