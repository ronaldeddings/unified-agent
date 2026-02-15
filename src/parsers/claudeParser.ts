/**
 * Claude Code JSONL session parser.
 *
 * Reads Claude Code session files line-by-line, mapping each JSON object
 * to a ParsedEvent. Handles assistant messages with text/tool_use blocks,
 * user messages with tool_result blocks, and system events.
 */

import type { ParsedEvent, SessionParser } from "./types.ts";

interface ClaudeContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string | ClaudeContentBlock[];
  is_error?: boolean;
}

interface ClaudeMessage {
  role?: string;
  content?: string | ClaudeContentBlock[];
  model?: string;
  stop_reason?: string;
}

interface ClaudeJsonlLine {
  type?: string;
  message?: ClaudeMessage;
  role?: string;
  content?: string | ClaudeContentBlock[];
  timestamp?: string;
  ts?: string;
  subtype?: string;
  parentMessageId?: string;
  isSidechain?: boolean;
}

function extractTextFromContent(
  content: string | ClaudeContentBlock[] | undefined,
): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === "text" && block.text) {
      parts.push(block.text);
    } else if (block.type === "tool_result") {
      const inner = typeof block.content === "string"
        ? block.content
        : extractTextFromContent(block.content as ClaudeContentBlock[] | undefined);
      if (inner) parts.push(inner);
    }
  }
  return parts.join("\n");
}

function extractToolUses(
  content: string | ClaudeContentBlock[] | undefined,
): { name: string; input?: string; output?: string }[] {
  if (!content || typeof content === "string") return [];
  const tools: { name: string; input?: string; output?: string }[] = [];
  for (const block of content) {
    if (block.type === "tool_use" && block.name) {
      tools.push({
        name: block.name,
        input: block.input ? JSON.stringify(block.input) : undefined,
      });
    }
  }
  return tools;
}

function extractToolResults(
  content: string | ClaudeContentBlock[] | undefined,
): { toolName?: string; toolOutput?: string; isError?: boolean }[] {
  if (!content || typeof content === "string") return [];
  const results: { toolName?: string; toolOutput?: string; isError?: boolean }[] = [];
  for (const block of content) {
    if (block.type === "tool_result") {
      const output = typeof block.content === "string"
        ? block.content
        : extractTextFromContent(block.content as ClaudeContentBlock[] | undefined);
      results.push({
        toolName: block.tool_use_id,
        toolOutput: output || undefined,
        isError: block.is_error || false,
      });
    }
  }
  return results;
}

function parseSingleLine(raw: string): ParsedEvent | null {
  let obj: ClaudeJsonlLine;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }

  const timestamp = obj.timestamp || obj.ts || undefined;

  // Assistant message with message.content
  if (obj.type === "assistant" && obj.message) {
    const msg = obj.message;
    const text = extractTextFromContent(msg.content);
    const toolCalls = extractToolUses(msg.content);
    return {
      type: "assistant",
      role: "assistant",
      content: text,
      timestamp,
      toolName: toolCalls.length > 0 ? toolCalls[0].name : undefined,
      toolInput: toolCalls.length > 0 ? toolCalls[0].input : undefined,
      metadata: {
        model: msg.model,
        stopReason: msg.stop_reason,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      },
      rawLine: raw,
    };
  }

  // User message — may contain tool_result blocks
  if (obj.type === "user") {
    const content = obj.message?.content ?? obj.content;
    const text = extractTextFromContent(content);
    const toolResults = extractToolResults(content);

    if (toolResults.length > 0) {
      return {
        type: "tool_result",
        role: "tool",
        content: text,
        timestamp,
        toolName: toolResults[0].toolName,
        toolOutput: toolResults[0].toolOutput,
        isError: toolResults[0].isError,
        metadata: { toolResults: toolResults.length > 1 ? toolResults : undefined },
        rawLine: raw,
      };
    }

    return {
      type: "user",
      role: "user",
      content: text,
      timestamp,
      rawLine: raw,
    };
  }

  // System events
  if (obj.type === "system") {
    const content = obj.message?.content ?? obj.content;
    const text = extractTextFromContent(content);
    return {
      type: "system",
      role: "system",
      content: text || JSON.stringify(obj),
      timestamp,
      rawLine: raw,
    };
  }

  // Summary / compaction events
  if (obj.type === "summary") {
    const content = obj.message?.content ?? obj.content;
    const text = extractTextFromContent(content);
    return {
      type: "summary",
      role: "system",
      content: text || JSON.stringify(obj),
      timestamp,
      metadata: { subtype: obj.subtype },
      rawLine: raw,
    };
  }

  // Fallback: any other event type
  return {
    type: obj.type || "unknown",
    role: undefined,
    content: JSON.stringify(obj),
    timestamp,
    rawLine: raw,
  };
}

async function* parseFromString(source: string): AsyncGenerator<ParsedEvent> {
  const lines = source.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const event = parseSingleLine(trimmed);
    if (event) yield event;
  }
}

async function* parseFromStream(source: ReadableStream): AsyncGenerator<ParsedEvent> {
  const reader = source.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newlineIdx = buffer.indexOf("\n");
      while (newlineIdx >= 0) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        if (line) {
          const event = parseSingleLine(line);
          if (event) yield event;
        }
        newlineIdx = buffer.indexOf("\n");
      }
    }

    // Flush remaining buffer
    const remaining = buffer.trim();
    if (remaining) {
      const event = parseSingleLine(remaining);
      if (event) yield event;
    }
  } finally {
    reader.releaseLock();
  }
}

export const claudeParser: SessionParser = {
  platform: "claude",

  async *parse(source: string | ReadableStream): AsyncGenerator<ParsedEvent> {
    if (typeof source === "string") {
      yield* parseFromString(source);
    } else {
      yield* parseFromStream(source);
    }
  },

  detect(filePath: string): boolean {
    return filePath.endsWith(".jsonl") && filePath.includes(".claude");
  },
};
