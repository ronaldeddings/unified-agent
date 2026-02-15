/**
 * Session generator interface and factory.
 * Each generator transforms a DistilledSession into a platform-native format.
 */

import type { DistilledSession } from "../distiller/distiller.ts";
import { claudeGenerator } from "./claudeGenerator.ts";
import { codexGenerator } from "./codexGenerator.ts";
import { geminiGenerator } from "./geminiGenerator.ts";

export type OutputPlatform = "claude" | "codex" | "gemini";

export interface SessionGenerator {
  platform: OutputPlatform;
  generate(distilled: DistilledSession, outputPath: string): Promise<string>;
}

const generators: Record<OutputPlatform, SessionGenerator> = {
  claude: claudeGenerator,
  codex: codexGenerator,
  gemini: geminiGenerator,
};

/**
 * Factory: returns the correct generator for the target platform.
 * Throws if an unsupported platform is provided.
 */
export function getGenerator(platform: OutputPlatform): SessionGenerator {
  const generator = generators[platform];
  if (!generator) {
    throw new Error(`Unsupported output platform: ${platform}`);
  }
  return generator;
}
