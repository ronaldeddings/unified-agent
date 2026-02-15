/**
 * Assessment prompt templates for multi-agent chunk evaluation.
 * Builds structured prompts that ask providers to rate conversation chunks
 * on relevance, signal density, and reusability.
 */

import type { Chunk } from "../scoring/chunker.ts";

export interface AssessmentRating {
  relevance: number;       // 1-10
  signalDensity: number;   // 1-10
  reusability: number;     // 1-10
  overallScore: number;    // 1-10
  rationale: string;
}

/**
 * Build a structured assessment prompt for a chunk.
 * The prompt asks the provider to rate the chunk on three criteria
 * and return a JSON response.
 */
export function buildAssessmentPrompt(
  chunk: Chunk,
  sourcePlatform?: string,
): string {
  const platformLabel = sourcePlatform || "unknown";
  const eventContent = chunk.events
    .map((e) => {
      const role = e.role ? `[${e.role}]` : "";
      const tool = e.toolName ? ` (tool: ${e.toolName})` : "";
      return `${role}${tool} ${e.content}`;
    })
    .join("\n---\n");

  return `You are evaluating a conversation chunk for inclusion in a distilled session.

**Conversation chunk (from ${platformLabel} session, ${chunk.events.length} events, ~${chunk.tokenEstimate} tokens):**
---
${eventContent}
---

Rate this chunk 1-10 on each criterion:

1. **Relevance**: How useful is this for understanding the project/task?
2. **Signal Density**: What ratio of the content is actionable vs noise/boilerplate?
3. **Reusability**: Would this help in a fresh session?

Respond with ONLY this JSON (no markdown, no explanation):
{"relevance": <1-10>, "signalDensity": <1-10>, "reusability": <1-10>, "overallScore": <1-10>, "rationale": "<one sentence>"}`;
}

/**
 * Parse a provider's assessment response into an AssessmentRating.
 * Attempts to extract JSON from the response, handling cases where
 * the provider wraps it in markdown or extra text.
 */
export function parseAssessmentResponse(response: string): AssessmentRating | null {
  // Try direct JSON parse first
  const trimmed = response.trim();
  const parsed = tryParseJson(trimmed);
  if (parsed && isValidRating(parsed)) return normalizeRating(parsed);

  // Try extracting JSON from markdown code blocks
  const codeBlockMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch) {
    const inner = tryParseJson(codeBlockMatch[1].trim());
    if (inner && isValidRating(inner)) return normalizeRating(inner);
  }

  // Try finding JSON object anywhere in the response
  const jsonMatch = trimmed.match(/\{[\s\S]*?"relevance"[\s\S]*?\}/);
  if (jsonMatch) {
    const inner = tryParseJson(jsonMatch[0]);
    if (inner && isValidRating(inner)) return normalizeRating(inner);
  }

  return null;
}

function tryParseJson(s: string): Record<string, unknown> | null {
  try {
    const obj = JSON.parse(s);
    if (typeof obj === "object" && obj !== null && !Array.isArray(obj)) {
      return obj as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function isValidRating(obj: Record<string, unknown>): boolean {
  return (
    typeof obj.relevance === "number" &&
    typeof obj.signalDensity === "number" &&
    typeof obj.reusability === "number" &&
    typeof obj.overallScore === "number" &&
    typeof obj.rationale === "string"
  );
}

/** Clamp scores to 1-10 range. */
function clampScore(v: number): number {
  return Math.max(1, Math.min(10, Math.round(v)));
}

function normalizeRating(obj: Record<string, unknown>): AssessmentRating {
  return {
    relevance: clampScore(obj.relevance as number),
    signalDensity: clampScore(obj.signalDensity as number),
    reusability: clampScore(obj.reusability as number),
    overallScore: clampScore(obj.overallScore as number),
    rationale: String(obj.rationale),
  };
}
