/**
 * Codex session generator — emits Codex CLI JSONL format
 * with type: "context" events and session metadata header.
 */

import type { DistilledSession } from "../distiller/distiller.ts";
import type { SessionGenerator } from "./index.ts";
import type { Chunk } from "../scoring/chunker.ts";

/**
 * Format a chunk's events into a content string for Codex.
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
 * Codex session generator implementing the SessionGenerator interface.
 * Produces Codex CLI compatible JSONL with:
 * - A metadata header line with session info
 * - Distilled chunks as type: "context" events
 */
export const codexGenerator: SessionGenerator = {
  platform: "codex",

  async generate(distilled: DistilledSession, outputPath: string): Promise<string> {
    const lines: string[] = [];

    // Emit metadata header as first line
    lines.push(JSON.stringify({
      type: "metadata",
      version: 1,
      sourceSessionIds: distilled.sourceSessionIds,
      sourcePlatforms: distilled.sourcePlatforms,
      totalTokens: distilled.totalTokens,
      chunkCount: distilled.chunks.length,
      distilledAt: distilled.distilledAt,
    }));

    // Emit each chunk as a context event
    for (const chunk of distilled.chunks) {
      const content = formatChunkContent(chunk);

      lines.push(JSON.stringify({
        type: "context",
        role: "assistant",
        content,
        metadata: {
          chunkId: chunk.id,
          sessionId: chunk.sessionId,
          importanceAvg: chunk.importanceAvg,
          tokenEstimate: chunk.tokenEstimate,
          startIndex: chunk.startIndex,
          endIndex: chunk.endIndex,
        },
      }));
    }

    const output = lines.join("\n") + "\n";
    await Bun.write(outputPath, output);
    return outputPath;
  },
};
