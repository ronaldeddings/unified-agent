/**
 * Importance scoring configuration and function signature.
 * Implementation will be added in Phase 3.
 */

import type { ParsedEvent } from "../parsers/types.ts";

export interface ScoringConfig {
  baseScore: number;          // Default: 50
  toolUseBonus: number;       // Default: 15
  errorBonus: number;         // Default: 20
  userPromptBonus: number;    // Default: 10
  codeBlockBonus: number;     // Default: 10
  fileEditBonus: number;      // Default: 12
  longContentPenalty: number; // Default: -5 (>2000 chars)
  systemEventPenalty: number; // Default: -20
  hookEventPenalty: number;   // Default: -15
}

export const DEFAULT_SCORING_CONFIG: ScoringConfig = {
  baseScore: 50,
  toolUseBonus: 15,
  errorBonus: 20,
  userPromptBonus: 10,
  codeBlockBonus: 10,
  fileEditBonus: 12,
  longContentPenalty: -5,
  systemEventPenalty: -20,
  hookEventPenalty: -15,
};

/**
 * Score a parsed event based on its characteristics.
 * Implementation in Phase 3.
 */
export function scoreEvent(
  _event: ParsedEvent,
  _config?: Partial<ScoringConfig>,
): number {
  throw new Error("scoreEvent() not yet implemented — Phase 3");
}
