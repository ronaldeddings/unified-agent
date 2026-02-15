/**
 * Gemini CLI JSON session parser.
 *
 * Reads Gemini CLI session files which may be JSON arrays or JSONL.
 * Maps message events with role: "assistant", tool_call/tool_use events,
 * and tool_result events to ParsedEvent objects.
 */

import type { ParsedEvent, SessionParser } from "./types.ts";

interface GeminiPart {
  text?: string;
  functionCall?: {
    name: string;
    args?: Record<string, unknown>;
  };
  functionResponse?: {
    name: string;
    response?: unknown;
  };
}

interface GeminiContent {
  role?: string;
  parts?: GeminiPart[];
}

interface GeminiJsonEntry {
  type?: string;
  role?: string;
  content?: GeminiContent | string;
  parts?: GeminiPart[];
  timestamp?: string;
  ts?: string;
  name?: string;
  args?: Record<string, unknown>;
  result?: unknown;
  model?: string;
  metadata?: Record<string, unknown>;
}

function extractTextFromParts(parts: GeminiPart[] | undefined): string {
  if (!parts) return "";
  return parts
    .filter((p) => p.text)
    .map((p) => p.text!)
    .join("\n");
}

function extractFunctionCalls(
  parts: GeminiPart[] | undefined,
): { name: string; input?: string }[] {
  if (!parts) return [];
  return parts
    .filter((p) => p.functionCall)
    .map((p) => ({
      name: p.functionCall!.name,
      input: p.functionCall!.args
        ? JSON.stringify(p.functionCall!.args)
        : undefined,
    }));
}

function extractFunctionResponses(
  parts: GeminiPart[] | undefined,
): { name: string; output?: string }[] {
  if (!parts) return [];
  return parts
    .filter((p) => p.functionResponse)
    .map((p) => ({
      name: p.functionResponse!.name,
      output: p.functionResponse!.response
        ? JSON.stringify(p.functionResponse!.response)
        : undefined,
    }));
}

function parseSingleEntry(obj: GeminiJsonEntry, raw?: string): ParsedEvent | null {
  const timestamp = obj.timestamp || obj.ts || undefined;
  const rawLine = raw || JSON.stringify(obj);

  // Content-based entry (Gemini conversation format)
  if (obj.content && typeof obj.content === "object" && "parts" in obj.content) {
    const content = obj.content as GeminiContent;
    const role = content.role || obj.role;
    const parts = content.parts;
    const text = extractTextFromParts(parts);
    const funcCalls = extractFunctionCalls(parts);
    const funcResponses = extractFunctionResponses(parts);

    if (funcResponses.length > 0) {
      return {
        type: "tool_result",
        role: "tool",
        content: funcResponses.map((r) => `${r.name}: ${r.output || ""}`).join("\n"),
        timestamp,
        toolName: funcResponses[0].name,
        toolOutput: funcResponses[0].output,
        metadata: { functionResponses: funcResponses },
        rawLine,
      };
    }

    if (funcCalls.length > 0) {
      return {
        type: "tool_call",
        role: "assistant",
        content: text || funcCalls.map((c) => `${c.name}(${c.input || ""})`).join("\n"),
        timestamp,
        toolName: funcCalls[0].name,
        toolInput: funcCalls[0].input,
        metadata: { functionCalls: funcCalls },
        rawLine,
      };
    }

    if (role === "model" || role === "assistant") {
      return {
        type: "assistant",
        role: "assistant",
        content: text,
        timestamp,
        rawLine,
      };
    }

    if (role === "user") {
      return {
        type: "user",
        role: "user",
        content: text,
        timestamp,
        rawLine,
      };
    }
  }

  // Direct parts on entry (alternative format)
  if (obj.parts) {
    const text = extractTextFromParts(obj.parts);
    const funcCalls = extractFunctionCalls(obj.parts);
    const funcResponses = extractFunctionResponses(obj.parts);
    const role = obj.role;

    if (funcResponses.length > 0) {
      return {
        type: "tool_result",
        role: "tool",
        content: funcResponses.map((r) => `${r.name}: ${r.output || ""}`).join("\n"),
        timestamp,
        toolName: funcResponses[0].name,
        toolOutput: funcResponses[0].output,
        rawLine,
      };
    }

    if (funcCalls.length > 0) {
      return {
        type: "tool_call",
        role: "assistant",
        content: text || funcCalls.map((c) => `${c.name}(${c.input || ""})`).join("\n"),
        timestamp,
        toolName: funcCalls[0].name,
        toolInput: funcCalls[0].input,
        rawLine,
      };
    }

    return {
      type: role === "model" || role === "assistant" ? "assistant" : role === "user" ? "user" : (role || "unknown"),
      role: role === "model" ? "assistant" : (role as ParsedEvent["role"]),
      content: text,
      timestamp,
      rawLine,
    };
  }

  // Typed events (type: "message", "tool_call", "tool_use", "tool_result")
  if (obj.type === "message") {
    const role = obj.role;
    const text = typeof obj.content === "string" ? obj.content : "";
    return {
      type: role === "assistant" || role === "model" ? "assistant" : role === "user" ? "user" : "message",
      role: role === "model" ? "assistant" : (role as ParsedEvent["role"]),
      content: text,
      timestamp,
      metadata: obj.metadata,
      rawLine,
    };
  }

  if (obj.type === "tool_call" || obj.type === "tool_use") {
    return {
      type: "tool_call",
      role: "assistant",
      content: `${obj.name || "tool"}(${obj.args ? JSON.stringify(obj.args) : ""})`,
      timestamp,
      toolName: obj.name,
      toolInput: obj.args ? JSON.stringify(obj.args) : undefined,
      rawLine,
    };
  }

  if (obj.type === "tool_result") {
    return {
      type: "tool_result",
      role: "tool",
      content: obj.result ? JSON.stringify(obj.result) : "",
      timestamp,
      toolName: obj.name,
      toolOutput: obj.result ? JSON.stringify(obj.result) : undefined,
      rawLine,
    };
  }

  // Fallback
  return {
    type: obj.type || "unknown",
    role: undefined,
    content: typeof obj.content === "string" ? obj.content : JSON.stringify(obj),
    timestamp,
    rawLine,
  };
}

async function* parseFromString(source: string): AsyncGenerator<ParsedEvent> {
  const trimmed = source.trim();

  // Try parsing as JSON array first
  if (trimmed.startsWith("[")) {
    try {
      const arr = JSON.parse(trimmed) as GeminiJsonEntry[];
      for (const entry of arr) {
        const event = parseSingleEntry(entry);
        if (event) yield event;
      }
      return;
    } catch {
      // Fall through to line-by-line
    }
  }

  // JSONL fallback (some Gemini formats use newline-delimited JSON)
  const lines = trimmed.split("\n");
  for (const line of lines) {
    const l = line.trim();
    if (!l) continue;
    try {
      const obj = JSON.parse(l) as GeminiJsonEntry;
      const event = parseSingleEntry(obj, l);
      if (event) yield event;
    } catch {
      // Skip unparseable lines
    }
  }
}

async function* parseFromStream(source: ReadableStream): AsyncGenerator<ParsedEvent> {
  const reader = source.getReader();
  const decoder = new TextDecoder();
  let fullContent = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      fullContent += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }

  // For JSON files, we need the full content to parse arrays
  yield* parseFromString(fullContent);
}

export const geminiParser: SessionParser = {
  platform: "gemini",

  async *parse(source: string | ReadableStream): AsyncGenerator<ParsedEvent> {
    if (typeof source === "string") {
      yield* parseFromString(source);
    } else {
      yield* parseFromStream(source);
    }
  },

  detect(filePath: string): boolean {
    return (filePath.endsWith(".json") || filePath.endsWith(".jsonl")) &&
      filePath.includes(".gemini");
  },
};
