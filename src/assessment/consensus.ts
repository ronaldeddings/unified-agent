/**
 * Consensus scorer — computes weighted average from multi-agent assessments.
 * Supports per-provider weights, minimum assessment threshold, and
 * optional outlier discarding (scores > 2 stddev from mean).
 */

import type { AssessmentResult } from "./assessor.ts";

export interface ConsensusConfig {
  weights: Record<string, number>;  // Default: { claude: 1.0, codex: 1.0, gemini: 1.0 }
  minAssessments: number;           // Default: 2 (at least 2 providers must respond)
  discardOutliers: boolean;         // Default: true (drop scores >2 stddev from mean)
}

export const DEFAULT_CONSENSUS_CONFIG: ConsensusConfig = {
  weights: { claude: 1.0, codex: 1.0, gemini: 1.0 },
  minAssessments: 2,
  discardOutliers: true,
};

/**
 * Compute the consensus score from multiple assessment results.
 * Returns 0 if fewer than minAssessments are provided.
 * Returns 0-10 weighted average, optionally with outlier discarding.
 */
export function computeConsensus(
  assessments: AssessmentResult[],
  config?: Partial<ConsensusConfig>,
): number {
  const cfg: ConsensusConfig = { ...DEFAULT_CONSENSUS_CONFIG, ...config };

  if (assessments.length < cfg.minAssessments) return 0;

  let scores = assessments.map((a) => ({
    score: a.score,
    weight: cfg.weights[a.provider] ?? 1.0,
  }));

  // Outlier discarding: drop scores > 2 stddev from mean
  if (cfg.discardOutliers && scores.length >= 3) {
    const rawScores = scores.map((s) => s.score);
    const mean = rawScores.reduce((a, b) => a + b, 0) / rawScores.length;
    const variance = rawScores.reduce((sum, s) => sum + (s - mean) ** 2, 0) / rawScores.length;
    const stddev = Math.sqrt(variance);

    if (stddev > 0) {
      const filtered = scores.filter((s) => Math.abs(s.score - mean) <= 2 * stddev);
      // Only discard if we still meet minAssessments after filtering
      if (filtered.length >= cfg.minAssessments) {
        scores = filtered;
      }
    }
  }

  // Weighted average
  let weightedSum = 0;
  let totalWeight = 0;
  for (const { score, weight } of scores) {
    weightedSum += score * weight;
    totalWeight += weight;
  }

  if (totalWeight === 0) return 0;

  const result = weightedSum / totalWeight;
  // Round to 2 decimal places
  return Math.round(result * 100) / 100;
}
