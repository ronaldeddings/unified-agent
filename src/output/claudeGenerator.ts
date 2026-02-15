/**
 * Claude session generator — emits Claude Code JSONL format
 * with compact_boundary markers and <system-reminder> wrapped content.
 */

import type { DistilledSession } from "../distiller/distiller.ts";
import type { SessionGenerator } from "./index.ts";
import type { Chunk } from "../scoring/chunker.ts";

/**
 * Build a single JSONL line for a Claude Code session event.
 */
function buildClaudeLine(
  type: string,
  role: "user" | "assistant" | "system",
  content: string,
  extra?: Record<string, unknown>,
): string {
  const obj: Record<string, unknown> = {
    type,
    role,
    content,
    timestamp: new Date().toISOString(),
    ...extra,
  };
  return JSON.stringify(obj);
}

/**
 * Wrap distilled content in <system-reminder> tags,
 * matching Claude Code's auto-compaction format.
 */
function wrapInSystemReminder(content: string): string {
  return `<system-reminder>\n${content}\n</system-reminder>`;
}

/**
 * Format a chunk's events into a readable summary block.
 */
function formatChunkContent(chunk: Chunk): string {
  const lines: string[] = [];
  for (const event of chunk.events) {
    const rolePrefix = event.role ? `[${event.role}]` : "[unknown]";
    if (event.toolName) {
      lines.push(`${rolePrefix} Tool: ${event.toolName}`);
      if (event.toolInput) lines.push(`  Input: ${event.toolInput.slice(0, 500)}`);
      if (event.toolOutput) lines.push(`  Output: ${event.toolOutput.slice(0, 500)}`);
    } else {
      lines.push(`${rolePrefix} ${event.content.slice(0, 1000)}`);
    }
  }
  return lines.join("\n");
}

/**
 * Claude session generator implementing the SessionGenerator interface.
 * Produces Claude Code compatible JSONL with:
 * - A compact_boundary summary header
 * - Distilled chunks wrapped in <system-reminder> blocks
 * - is_sidechain: true for injected context
 */
export const claudeGenerator: SessionGenerator = {
  platform: "claude",

  async generate(distilled: DistilledSession, outputPath: string): Promise<string> {
    const lines: string[] = [];

    // Emit compact_boundary header — marks this as a compacted/distilled session
    lines.push(buildClaudeLine("summary", "system", "compact_boundary", {
      is_sidechain: true,
      compact_boundary: true,
      sourceSessionIds: distilled.sourceSessionIds,
      sourcePlatforms: distilled.sourcePlatforms,
      totalTokens: distilled.totalTokens,
      chunkCount: distilled.chunks.length,
      distilledAt: distilled.distilledAt,
    }));

    // Emit each chunk as a system-reminder wrapped assistant message
    for (const chunk of distilled.chunks) {
      const content = formatChunkContent(chunk);
      const wrapped = wrapInSystemReminder(content);

      lines.push(buildClaudeLine("summary", "assistant", wrapped, {
        is_sidechain: true,
        chunkId: chunk.id,
        sessionId: chunk.sessionId,
        importanceAvg: chunk.importanceAvg,
        tokenEstimate: chunk.tokenEstimate,
        startIndex: chunk.startIndex,
        endIndex: chunk.endIndex,
      }));
    }

    const output = lines.join("\n") + "\n";
    await Bun.write(outputPath, output);
    return outputPath;
  },
};
