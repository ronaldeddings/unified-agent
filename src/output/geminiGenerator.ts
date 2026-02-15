/**
 * Gemini session generator — emits Gemini CLI JSON format
 * with conversation history mapped to parts array structure.
 */

import type { DistilledSession } from "../distiller/distiller.ts";
import type { SessionGenerator } from "./index.ts";
import type { Chunk } from "../scoring/chunker.ts";

interface GeminiPart {
  text: string;
}

interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

interface GeminiSession {
  metadata: {
    sourceSessionIds: string[];
    sourcePlatforms: string[];
    totalTokens: number;
    chunkCount: number;
    distilledAt: string;
  };
  contents: GeminiContent[];
}

/**
 * Map a ParsedEvent role to Gemini's role format.
 * Gemini uses "user" and "model" (not "assistant").
 */
function toGeminiRole(role?: string): "user" | "model" {
  if (role === "user") return "user";
  return "model";
}

/**
 * Format a chunk's events into Gemini content entries.
 * Groups consecutive same-role events into single content blocks.
 */
function chunkToContents(chunk: Chunk): GeminiContent[] {
  const contents: GeminiContent[] = [];
  let currentRole: "user" | "model" | null = null;
  let currentParts: GeminiPart[] = [];

  for (const event of chunk.events) {
    const role = toGeminiRole(event.role);

    if (role !== currentRole && currentParts.length > 0) {
      contents.push({ role: currentRole!, parts: currentParts });
      currentParts = [];
    }

    currentRole = role;

    if (event.toolName) {
      const toolText = [
        `Tool: ${event.toolName}`,
        event.toolInput ? `Input: ${event.toolInput.slice(0, 500)}` : "",
        event.toolOutput ? `Output: ${event.toolOutput.slice(0, 500)}` : "",
      ].filter(Boolean).join("\n");
      currentParts.push({ text: toolText });
    } else {
      currentParts.push({ text: event.content.slice(0, 1000) });
    }
  }

  // Flush remaining parts
  if (currentParts.length > 0 && currentRole !== null) {
    contents.push({ role: currentRole, parts: currentParts });
  }

  return contents;
}

/**
 * Gemini session generator implementing the SessionGenerator interface.
 * Produces Gemini CLI compatible JSON with:
 * - Session metadata
 * - Conversation contents with parts arrays
 */
export const geminiGenerator: SessionGenerator = {
  platform: "gemini",

  async generate(distilled: DistilledSession, outputPath: string): Promise<string> {
    const allContents: GeminiContent[] = [];

    for (const chunk of distilled.chunks) {
      const contents = chunkToContents(chunk);
      allContents.push(...contents);
    }

    const session: GeminiSession = {
      metadata: {
        sourceSessionIds: distilled.sourceSessionIds,
        sourcePlatforms: distilled.sourcePlatforms,
        totalTokens: distilled.totalTokens,
        chunkCount: distilled.chunks.length,
        distilledAt: distilled.distilledAt,
      },
      contents: allContents,
    };

    const output = JSON.stringify(session, null, 2) + "\n";
    await Bun.write(outputPath, output);
    return outputPath;
  },
};
