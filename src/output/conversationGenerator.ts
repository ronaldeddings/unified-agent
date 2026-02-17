/**
 * Conversation-quality session generator — emits Claude Code JSONL format
 * with natural user/assistant Q&A turns.
 *
 * Unlike the summary-based claudeGenerator (which produces compact_boundary/system-reminder blocks),
 * this generator produces events that look like real conversations Claude participated in.
 * This gives Claude "first-person ownership" of the project knowledge when resumed.
 *
 * Schema matches real Claude Code session files for `claude --resume` compatibility:
 * - User events: type "user", message.role "user", content as string
 * - Assistant events: type "assistant", message with model/id/content/usage
 * - uuid/parentUuid chain links all events
 * - Realistic timestamp spacing between turns
 */

import { randomUUID } from "node:crypto";
import type { DistilledSession } from "../distiller/distiller.ts";
import type { SessionGenerator } from "./index.ts";
import type { Chunk } from "../scoring/chunker.ts";

/** Claude Code version to stamp on generated events. */
const CLAUDE_CODE_VERSION = "2.1.0";

/** Model identifier for generated assistant responses. */
const DEFAULT_MODEL = "claude-sonnet-4-5-20250929";

export interface ConversationOptions {
  /** Working directory for the project. */
  cwd: string;
  /** Git branch name (empty string if unknown). */
  gitBranch?: string;
  /** Model to use in assistant message metadata. */
  model?: string;
  /** Session ID override (auto-generated if not provided). */
  sessionId?: string;
}

interface ConversationEvent {
  type: "user" | "assistant";
  uuid: string;
  parentUuid: string | null;
  sessionId: string;
  cwd: string;
  timestamp: string;
  version: string;
  gitBranch: string;
  isSidechain: boolean;
  userType: "external";
  message: UserMessage | AssistantMessage;
}

interface UserMessage {
  role: "user";
  content: string;
}

interface AssistantMessage {
  model: string;
  id: string;
  type: "message";
  role: "assistant";
  content: Array<{ type: "text"; text: string }>;
  stop_reason: "end_turn";
  stop_sequence: null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    service_tier: "standard";
  };
}

/**
 * Generate a unique session ID matching Claude Code format.
 */
export function generateSessionId(): string {
  return randomUUID();
}

/**
 * Generate the preamble user message — establishes project context.
 */
export function generatePreamble(cwd: string, distilled: DistilledSession): string {
  const sessionCount = distilled.sourceSessionIds.length;
  const platforms = [...new Set(distilled.sourcePlatforms)].join(", ");
  return [
    `I've been working on the project at ${cwd}.`,
    `Can you review the key decisions, architecture, patterns, and recent changes`,
    `from my ${sessionCount} most recent session(s) across ${platforms}?`,
    `I want you to have complete context so you can help me effectively.`,
  ].join(" ");
}

/**
 * Generate a user turn asking about a topic.
 */
export function generateUserTurn(topic: string, chunkCount: number): string {
  if (topic === "preamble") {
    return `Let's start with the overall project context and architecture.`;
  }
  if (chunkCount === 1) {
    return `What about ${topic}?`;
  }
  return `Tell me about the ${topic} — what are the key details I should know?`;
}

/**
 * Generate an assistant turn from chunk content.
 * Formats the chunk events into a coherent response.
 */
export function generateAssistantTurn(chunks: Chunk[]): string {
  const parts: string[] = [];

  for (const chunk of chunks) {
    for (const event of chunk.events) {
      if (event.role === "assistant" && event.content.trim()) {
        parts.push(event.content.trim());
      } else if (event.role === "user" && event.content.trim()) {
        // Include user context that provides important decisions/requirements
        if (event.content.length > 50) {
          parts.push(`Based on the discussion: ${event.content.trim().slice(0, 2000)}`);
        }
      }
      if (event.toolName && event.toolOutput) {
        parts.push(`Tool ${event.toolName}: ${event.toolOutput.trim().slice(0, 1000)}`);
      }
    }
  }

  if (parts.length === 0) {
    // Fallback: use raw chunk content
    return chunks.map((c) => c.events.map((e) => e.content).join("\n")).join("\n\n");
  }

  return parts.join("\n\n");
}

/**
 * Create a user event matching Claude Code JSONL format.
 */
function makeUserEvent(
  content: string,
  sessionId: string,
  cwd: string,
  uuid: string,
  parentUuid: string | null,
  timestamp: string,
  gitBranch: string,
): ConversationEvent {
  return {
    type: "user",
    uuid,
    parentUuid,
    sessionId,
    cwd,
    timestamp,
    version: CLAUDE_CODE_VERSION,
    gitBranch,
    isSidechain: false,
    userType: "external",
    message: {
      role: "user",
      content,
    },
  };
}

/**
 * Create an assistant event matching Claude Code JSONL format.
 */
function makeAssistantEvent(
  content: string,
  model: string,
  sessionId: string,
  cwd: string,
  uuid: string,
  parentUuid: string,
  timestamp: string,
  gitBranch: string,
): ConversationEvent {
  const tokenEstimate = Math.ceil(content.length / 4);
  return {
    type: "assistant",
    uuid,
    parentUuid,
    sessionId,
    cwd,
    timestamp,
    version: CLAUDE_CODE_VERSION,
    gitBranch,
    isSidechain: false,
    userType: "external",
    message: {
      model,
      id: `msg_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: content }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: tokenEstimate * 2,
        output_tokens: tokenEstimate,
        service_tier: "standard",
      },
    },
  };
}

/**
 * Generate a realistic timestamp offset from a base time.
 * Adds 30-120 seconds for user turns, 5-30 seconds for assistant turns.
 */
function advanceTimestamp(base: Date, isUser: boolean): Date {
  const minMs = isUser ? 30_000 : 5_000;
  const maxMs = isUser ? 120_000 : 30_000;
  const offset = minMs + Math.random() * (maxMs - minMs);
  return new Date(base.getTime() + offset);
}

/**
 * Group distilled chunks into topic-based conversation turns.
 * Simple approach: each chunk becomes one Q&A pair.
 * For better results, use the synthesizer (Phase 12) to group by topic first.
 */
function groupChunksIntoTurns(chunks: Chunk[]): Array<{ topic: string; chunks: Chunk[] }> {
  // Simple grouping: each chunk is its own turn
  // Phase 12's synthesizer will provide smarter topic-based grouping
  return chunks.map((chunk, i) => {
    const firstContent = chunk.events[0]?.content || "";
    const topic = inferTopic(firstContent, i);
    return { topic, chunks: [chunk] };
  });
}

/**
 * Infer a conversational topic from chunk content.
 */
function inferTopic(content: string, index: number): string {
  const lower = content.toLowerCase();
  if (lower.includes("architect") || lower.includes("design") || lower.includes("structure")) return "architecture and design";
  if (lower.includes("deploy") || lower.includes("production") || lower.includes("ci/cd")) return "deployment and infrastructure";
  if (lower.includes("test") || lower.includes("spec") || lower.includes("coverage")) return "testing strategy";
  if (lower.includes("bug") || lower.includes("fix") || lower.includes("error")) return "bug fixes and issues";
  if (lower.includes("refactor") || lower.includes("cleanup") || lower.includes("improve")) return "refactoring decisions";
  if (lower.includes("api") || lower.includes("endpoint") || lower.includes("route")) return "API design";
  if (lower.includes("database") || lower.includes("schema") || lower.includes("migration")) return "database and data model";
  if (lower.includes("config") || lower.includes("setting") || lower.includes("env")) return "configuration";
  return `topic ${index + 1}`;
}

/**
 * Conversation-quality session generator.
 * Produces Claude Code JSONL with natural user/assistant turns
 * for use with `claude --resume`.
 */
export const conversationGenerator: SessionGenerator = {
  platform: "claude",

  async generate(distilled: DistilledSession, outputPath: string, options?: ConversationOptions): Promise<string> {
    const cwd = options?.cwd || process.cwd();
    const gitBranch = options?.gitBranch || "";
    const model = options?.model || DEFAULT_MODEL;
    const sessionId = options?.sessionId || generateSessionId();

    const lines: string[] = [];
    let lastUuid: string | null = null;
    let currentTime = new Date();

    // Generate preamble: user establishes context
    const preambleContent = generatePreamble(cwd, distilled);
    const preambleUuid = randomUUID();
    lines.push(JSON.stringify(makeUserEvent(
      preambleContent,
      sessionId,
      cwd,
      preambleUuid,
      null,
      currentTime.toISOString(),
      gitBranch,
    )));
    lastUuid = preambleUuid;

    // Assistant acknowledges and provides overview
    currentTime = advanceTimestamp(currentTime, false);
    const overviewUuid = randomUUID();
    const overviewContent = [
      `I have context from ${distilled.sourceSessionIds.length} session(s) covering this project.`,
      `Here's what I know about the key aspects of your work at ${cwd}.`,
      `I'll cover the main topics based on ${distilled.chunks.length} significant conversation segments.`,
    ].join(" ");
    lines.push(JSON.stringify(makeAssistantEvent(
      overviewContent,
      model,
      sessionId,
      cwd,
      overviewUuid,
      lastUuid,
      currentTime.toISOString(),
      gitBranch,
    )));
    lastUuid = overviewUuid;

    // Generate Q&A turns from distilled chunks
    const turns = groupChunksIntoTurns(distilled.chunks);

    for (const turn of turns) {
      // User asks about topic
      currentTime = advanceTimestamp(currentTime, true);
      const userUuid = randomUUID();
      const userContent = generateUserTurn(turn.topic, turn.chunks.length);
      lines.push(JSON.stringify(makeUserEvent(
        userContent,
        sessionId,
        cwd,
        userUuid,
        lastUuid,
        currentTime.toISOString(),
        gitBranch,
      )));
      lastUuid = userUuid;

      // Assistant responds with synthesized knowledge
      currentTime = advanceTimestamp(currentTime, false);
      const assistantUuid = randomUUID();
      const assistantContent = generateAssistantTurn(turn.chunks);
      lines.push(JSON.stringify(makeAssistantEvent(
        assistantContent,
        model,
        sessionId,
        cwd,
        assistantUuid,
        lastUuid,
        currentTime.toISOString(),
        gitBranch,
      )));
      lastUuid = assistantUuid;
    }

    const output = lines.join("\n") + "\n";
    await Bun.write(outputPath, output);
    return outputPath;
  },
};
