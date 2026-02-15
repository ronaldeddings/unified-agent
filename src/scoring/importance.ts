/**
 * Importance scoring for parsed events.
 * Assigns a 0-100 score based on event characteristics using a base + bonus system.
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

/** Tool names that indicate file editing operations. */
const FILE_EDIT_TOOLS = new Set([
  "edit", "write", "notebookedit",
  "Edit", "Write", "NotebookEdit",
]);

/** Event type prefixes that indicate hook events. */
const HOOK_TYPE_PREFIXES = ["hook", "custom_hook"];

/** Clamp a value to the 0-100 range. */
function clamp(value: number): number {
  return Math.max(0, Math.min(100, value));
}

/** Check if content contains code blocks (triple backticks). */
function hasCodeBlock(content: string): boolean {
  return content.includes("```");
}

/** Check if an event type represents a hook event. */
function isHookEvent(type: string): boolean {
  const lower = type.toLowerCase();
  return HOOK_TYPE_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/**
 * Score a parsed event based on its characteristics.
 * Starts with baseScore, applies cumulative bonuses/penalties, clamps to 0-100.
 */
export function scoreEvent(
  event: ParsedEvent,
  config?: Partial<ScoringConfig>,
): number {
  const cfg: ScoringConfig = { ...DEFAULT_SCORING_CONFIG, ...config };
  let score = cfg.baseScore;

  // Tool use bonus: event has a tool name or tool input
  if (event.toolName || event.toolInput) {
    score += cfg.toolUseBonus;
  }

  // Error bonus: event is marked as error
  if (event.isError) {
    score += cfg.errorBonus;
  }

  // User prompt bonus: role is "user" and type is not tool_result
  if (event.role === "user" && event.type !== "tool_result") {
    score += cfg.userPromptBonus;
  }

  // Code block bonus: content contains triple backticks
  if (hasCodeBlock(event.content)) {
    score += cfg.codeBlockBonus;
  }

  // File edit bonus: tool name matches known file edit tools
  if (event.toolName && FILE_EDIT_TOOLS.has(event.toolName)) {
    score += cfg.fileEditBonus;
  }

  // Long content penalty: content exceeds 2000 characters
  if (event.content.length > 2000) {
    score += cfg.longContentPenalty;
  }

  // System event penalty: role is "system" or type is "system"
  if (event.role === "system" || event.type === "system") {
    score += cfg.systemEventPenalty;
  }

  // Hook event penalty: type starts with hook-related prefix
  if (isHookEvent(event.type)) {
    score += cfg.hookEventPenalty;
  }

  return clamp(score);
}
