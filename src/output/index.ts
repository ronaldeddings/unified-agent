/**
 * Session generator interface and factory.
 * Each generator transforms a DistilledSession into a platform-native format.
 * Implementation will be added in Phase 5.
 */

import type { DistilledSession } from "../distiller/distiller.ts";

export type OutputPlatform = "claude" | "codex" | "gemini";

export interface SessionGenerator {
  platform: OutputPlatform;
  generate(distilled: DistilledSession, outputPath: string): Promise<string>;
}

/**
 * Factory: returns the correct generator for the target platform.
 * Implementation in Phase 5.
 */
export function getGenerator(_platform: OutputPlatform): SessionGenerator {
  throw new Error("getGenerator() not yet implemented — Phase 5");
}
