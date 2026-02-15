/**
 * Parser auto-detection and factory.
 *
 * Detects the correct parser for a given file based on file extension
 * and first-line structure heuristics. Exports all parsers and the
 * detection utility.
 */

import { claudeParser } from "./claudeParser.ts";
import { codexParser } from "./codexParser.ts";
import { geminiParser } from "./geminiParser.ts";
import type { PlatformName, SessionParser } from "./types.ts";

export { claudeParser } from "./claudeParser.ts";
export { codexParser } from "./codexParser.ts";
export { geminiParser } from "./geminiParser.ts";
export type { ParsedEvent, PlatformName, SessionParser } from "./types.ts";

const ALL_PARSERS: SessionParser[] = [claudeParser, codexParser, geminiParser];

/**
 * Detect the correct parser for a file based on path heuristics.
 * Checks each parser's detect() method. Returns null if no match.
 */
export function detectParserByPath(filePath: string): SessionParser | null {
  for (const parser of ALL_PARSERS) {
    if (parser.detect(filePath)) return parser;
  }
  return null;
}

/**
 * Detect the correct parser by examining the first line of content.
 * Uses structural heuristics to identify the platform format.
 */
export function detectParserByContent(firstLine: string): SessionParser | null {
  const trimmed = firstLine.trim();
  if (!trimmed) return null;

  // JSON array starting with [ — likely Gemini
  if (trimmed.startsWith("[")) return geminiParser;

  // Try to parse as JSON
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return null;
  }

  // Claude heuristics: has "type" field with "assistant"/"user"/"system"
  // and either "message" field or content blocks pattern
  if (
    obj.type === "assistant" &&
    obj.message &&
    typeof obj.message === "object"
  ) {
    return claudeParser;
  }
  if (
    obj.type === "user" &&
    (obj.message || obj.content)
  ) {
    return claudeParser;
  }
  if (obj.type === "system") {
    return claudeParser;
  }
  if (obj.type === "summary") {
    return claudeParser;
  }

  // Codex heuristics: "type" field with "item.completed" or "turn.completed"
  if (
    obj.type === "item.completed" ||
    obj.type === "turn.completed"
  ) {
    return codexParser;
  }

  // Gemini heuristics: has "content" with "parts", or typed events
  if (obj.type === "message" && (obj.role || obj.content)) {
    return geminiParser;
  }
  if (obj.type === "tool_call" || obj.type === "tool_use" || obj.type === "tool_result") {
    return geminiParser;
  }
  if (
    obj.content &&
    typeof obj.content === "object" &&
    !Array.isArray(obj.content) &&
    "parts" in (obj.content as Record<string, unknown>)
  ) {
    return geminiParser;
  }
  if (obj.parts && Array.isArray(obj.parts)) {
    return geminiParser;
  }

  return null;
}

/**
 * Detect the correct parser using both path and content heuristics.
 * Path-based detection takes priority; falls back to content-based.
 */
export function detectParser(
  filePath: string,
  firstLine?: string,
): SessionParser | null {
  const byPath = detectParserByPath(filePath);
  if (byPath) return byPath;

  if (firstLine) {
    return detectParserByContent(firstLine);
  }

  return null;
}

/**
 * Get a parser by platform name.
 */
export function getParser(platform: PlatformName): SessionParser {
  switch (platform) {
    case "claude":
      return claudeParser;
    case "codex":
      return codexParser;
    case "gemini":
      return geminiParser;
  }
}
