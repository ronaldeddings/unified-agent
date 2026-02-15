/**
 * Real-time scoring hook for SessionManager.
 * Wraps recordEvent() to attach importanceScore before persistence.
 */

import type { SessionManager } from "../session/manager.ts";
import type { CanonicalEvent } from "../session/types.ts";
import type { ParsedEvent } from "../parsers/types.ts";
import { scoreEvent, type ScoringConfig } from "./importance.ts";

/**
 * Convert a CanonicalEvent to a ParsedEvent for scoring.
 * Maps canonical fields to the parsed event interface the scorer expects.
 */
function canonicalToParsed(event: CanonicalEvent): ParsedEvent {
  const role = event.type === "user_message"
    ? "user" as const
    : event.type === "assistant_message"
      ? "assistant" as const
      : event.type === "error"
        ? "assistant" as const
        : "system" as const;

  const isError = event.type === "error";

  // Extract tool info from payload if present
  const payload = event.payload as Record<string, unknown> | undefined;
  const toolName = (payload?.toolName as string) ?? undefined;
  const toolInput = (payload?.toolInput as string) ?? undefined;
  const toolOutput = (payload?.toolOutput as string) ?? undefined;

  return {
    type: event.type,
    role,
    content: event.text,
    timestamp: event.ts,
    toolName,
    toolInput,
    toolOutput,
    isError,
  };
}

/**
 * Wrap a SessionManager so that every recordEvent() call automatically
 * scores the event and attaches importanceScore before persistence.
 * Scoring is synchronous and lightweight (~0.1ms per event).
 */
export function wrapSessionManagerWithScoring(
  manager: SessionManager,
  config?: Partial<ScoringConfig>,
): SessionManager {
  const originalRecordEvent = manager.recordEvent.bind(manager);

  manager.recordEvent = async function scoringRecordEvent(event: CanonicalEvent): Promise<void> {
    const parsed = canonicalToParsed(event);
    event.importanceScore = scoreEvent(parsed, config);
    return originalRecordEvent(event);
  };

  return manager;
}
