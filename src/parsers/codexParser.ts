/**
 * Codex CLI JSONL session parser.
 *
 * Reads Codex CLI session files line-by-line, mapping each JSON object
 * to a ParsedEvent. Handles item.completed events (command_execution,
 * reasoning), turn.completed for usage tracking, and user messages.
 */

import type { ParsedEvent, SessionParser } from "./types.ts";

interface CodexItem {
  type?: string;
  id?: string;
  role?: string;
  content?: CodexContent[];
  status?: string;
}

interface CodexContent {
  type?: string;
  text?: string;
  annotations?: unknown[];
}

interface CodexCommandExecution {
  type?: string;
  id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  status?: string;
  output?: CodexContent[];
}

interface CodexUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
}

interface CodexJsonlLine {
  type?: string;
  item?: CodexItem & CodexCommandExecution;
  response?: {
    usage?: CodexUsage;
    model?: string;
  };
  timestamp?: string;
  ts?: string;
  role?: string;
  content?: string;
  message?: string;
}

function extractContentText(content: CodexContent[] | undefined): string {
  if (!content) return "";
  return content
    .filter((c) => c.type === "text" || c.type === "output_text")
    .map((c) => c.text || "")
    .join("\n");
}

function parseSingleLine(raw: string): ParsedEvent | null {
  let obj: CodexJsonlLine;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }

  const timestamp = obj.timestamp || obj.ts || undefined;

  // item.completed with command_execution — tool use
  if (obj.type === "item.completed" && obj.item?.type === "command_execution") {
    const item = obj.item;
    const output = extractContentText(item.output);
    return {
      type: "tool_use",
      role: "tool",
      content: output || `${item.name || "command"}: ${item.arguments || ""}`,
      timestamp,
      toolName: item.name || "shell",
      toolInput: item.arguments || undefined,
      toolOutput: output || undefined,
      isError: item.status === "failed",
      metadata: {
        callId: item.call_id,
        status: item.status,
      },
      rawLine: raw,
    };
  }

  // item.completed with function_call — also tool use
  if (obj.type === "item.completed" && obj.item?.type === "function_call") {
    const item = obj.item;
    const output = extractContentText(item.output);
    return {
      type: "tool_use",
      role: "tool",
      content: output || `${item.name || "function"}: ${item.arguments || ""}`,
      timestamp,
      toolName: item.name || "function",
      toolInput: item.arguments || undefined,
      toolOutput: output || undefined,
      isError: item.status === "failed",
      metadata: {
        callId: item.call_id,
        status: item.status,
      },
      rawLine: raw,
    };
  }

  // item.completed with reasoning — assistant reasoning
  if (obj.type === "item.completed" && obj.item?.type === "reasoning") {
    const text = extractContentText(obj.item.content);
    return {
      type: "reasoning",
      role: "assistant",
      content: text,
      timestamp,
      rawLine: raw,
    };
  }

  // item.completed with message role=assistant — assistant output
  if (obj.type === "item.completed" && obj.item?.role === "assistant") {
    const text = extractContentText(obj.item.content);
    return {
      type: "assistant",
      role: "assistant",
      content: text,
      timestamp,
      rawLine: raw,
    };
  }

  // item.completed with message role=user — user input
  if (obj.type === "item.completed" && obj.item?.role === "user") {
    const text = extractContentText(obj.item.content);
    return {
      type: "user",
      role: "user",
      content: text,
      timestamp,
      rawLine: raw,
    };
  }

  // turn.completed — usage tracking
  if (obj.type === "turn.completed") {
    const usage = obj.response?.usage;
    return {
      type: "usage",
      role: undefined,
      content: usage
        ? `tokens: ${usage.input_tokens ?? 0} in / ${usage.output_tokens ?? 0} out`
        : "turn completed",
      timestamp,
      metadata: {
        model: obj.response?.model,
        usage,
      },
      rawLine: raw,
    };
  }

  // Direct user message (some Codex formats)
  if (obj.type === "user" || obj.role === "user") {
    return {
      type: "user",
      role: "user",
      content: obj.content || obj.message || JSON.stringify(obj),
      timestamp,
      rawLine: raw,
    };
  }

  // Fallback
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

    const remaining = buffer.trim();
    if (remaining) {
      const event = parseSingleLine(remaining);
      if (event) yield event;
    }
  } finally {
    reader.releaseLock();
  }
}

export const codexParser: SessionParser = {
  platform: "codex",

  async *parse(source: string | ReadableStream): AsyncGenerator<ParsedEvent> {
    if (typeof source === "string") {
      yield* parseFromString(source);
    } else {
      yield* parseFromStream(source);
    }
  },

  detect(filePath: string): boolean {
    return filePath.endsWith(".jsonl") && filePath.includes(".codex");
  },
};
