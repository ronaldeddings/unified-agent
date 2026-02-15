/**
 * Common types for cross-platform session parsers.
 * Each platform parser (Claude, Codex, Gemini) emits ParsedEvent objects
 * through a common SessionParser interface.
 */

export interface ParsedEvent {
  type: string;
  role?: "user" | "assistant" | "system" | "tool";
  content: string;
  timestamp?: string;
  toolName?: string;
  toolInput?: string;
  toolOutput?: string;
  isError?: boolean;
  metadata?: Record<string, unknown>;
  rawLine?: string;
}

export type PlatformName = "claude" | "codex" | "gemini";

export interface SessionParser {
  platform: PlatformName;
  parse(source: string | ReadableStream): AsyncGenerator<ParsedEvent>;
  detect(filePath: string): boolean;
}
