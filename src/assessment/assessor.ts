/**
 * Multi-agent assessment — spawns provider CLIs to rate conversation chunks.
 * Uses runStreamingCommand() for CLI spawning, AbortController for timeouts,
 * and one-retry logic per provider per chunk.
 */

import type { Chunk } from "../scoring/chunker.ts";
import { runStreamingCommand } from "../providers/stream.ts";
import { buildAssessmentPrompt, parseAssessmentResponse } from "./prompts.ts";

export interface AssessmentResult {
  provider: "claude" | "codex" | "gemini";
  chunkId: string;
  score: number;        // 1-10
  rationale: string;
  model?: string;
  tokensUsed?: number;
  latencyMs: number;
}

export interface AssessorConfig {
  providers: ("claude" | "codex" | "gemini")[];  // Default: all three
  timeoutMs: number;                              // Default: 30000
  maxConcurrent: number;                          // Default: 3
  retryOnFailure: boolean;                        // Default: true
  cwd: string;                                    // Working directory for spawned CLIs
}

export const DEFAULT_ASSESSOR_CONFIG: AssessorConfig = {
  providers: ["claude", "codex", "gemini"],
  timeoutMs: 30000,
  maxConcurrent: 3,
  retryOnFailure: true,
  cwd: process.cwd(),
};

/** Build CLI args for each provider to run a one-shot assessment prompt. */
function buildProviderArgs(provider: "claude" | "codex" | "gemini", prompt: string): { cmd: string; args: string[] } {
  switch (provider) {
    case "claude":
      return {
        cmd: "claude",
        args: ["-p", "--output-format", "text", "--dangerously-skip-permissions", prompt],
      };
    case "codex":
      return {
        cmd: "codex",
        args: ["exec", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", "-q", prompt],
      };
    case "gemini":
      return {
        cmd: "gemini",
        args: ["-p", prompt, "--yolo"],
      };
  }
}

/**
 * Run a single assessment of a chunk against one provider.
 * Returns null if the provider fails or times out.
 */
async function runSingleAssessment(
  chunk: Chunk,
  provider: "claude" | "codex" | "gemini",
  timeoutMs: number,
  cwd: string,
): Promise<AssessmentResult | null> {
  const prompt = buildAssessmentPrompt(chunk);
  const { cmd, args } = buildProviderArgs(provider, prompt);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startMs = Date.now();

  try {
    const { stdout, code } = await runStreamingCommand(cmd, args, cwd, {
      signal: controller.signal,
    });

    if (code !== 0) return null;

    const rating = parseAssessmentResponse(stdout);
    if (!rating) return null;

    return {
      provider,
      chunkId: chunk.id,
      score: rating.overallScore,
      rationale: rating.rationale,
      latencyMs: Date.now() - startMs,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Assess a single chunk using multiple providers.
 * Spawns one CLI per provider in parallel, collects results.
 * Retries failed providers once if retryOnFailure is enabled.
 */
export async function assessChunk(
  chunk: Chunk,
  config?: Partial<AssessorConfig>,
): Promise<AssessmentResult[]> {
  const cfg: AssessorConfig = { ...DEFAULT_ASSESSOR_CONFIG, ...config };
  const results: AssessmentResult[] = [];
  const failedProviders: ("claude" | "codex" | "gemini")[] = [];

  // First pass: assess all providers in parallel
  const firstPass = await Promise.all(
    cfg.providers.map((provider) =>
      runSingleAssessment(chunk, provider, cfg.timeoutMs, cfg.cwd)
    ),
  );

  for (let i = 0; i < firstPass.length; i++) {
    const result = firstPass[i];
    if (result) {
      results.push(result);
    } else {
      failedProviders.push(cfg.providers[i]);
    }
  }

  // Retry pass: one retry per failed provider
  if (cfg.retryOnFailure && failedProviders.length > 0) {
    const retryPass = await Promise.all(
      failedProviders.map((provider) =>
        runSingleAssessment(chunk, provider, cfg.timeoutMs, cfg.cwd)
      ),
    );

    for (const result of retryPass) {
      if (result) results.push(result);
    }
  }

  return results;
}

/**
 * Assess multiple chunks with parallel execution and progress reporting.
 * Limits concurrency to maxConcurrent chunks at a time.
 */
export async function assessChunks(
  chunks: Chunk[],
  config?: Partial<AssessorConfig>,
  onProgress?: (completed: number, total: number) => void,
): Promise<Map<string, AssessmentResult[]>> {
  const cfg: AssessorConfig = { ...DEFAULT_ASSESSOR_CONFIG, ...config };
  const resultMap = new Map<string, AssessmentResult[]>();
  let completed = 0;

  // Process chunks in batches of maxConcurrent
  for (let i = 0; i < chunks.length; i += cfg.maxConcurrent) {
    const batch = chunks.slice(i, i + cfg.maxConcurrent);

    const batchResults = await Promise.all(
      batch.map((chunk) => assessChunk(chunk, cfg)),
    );

    for (let j = 0; j < batch.length; j++) {
      resultMap.set(batch[j].id, batchResults[j]);
      completed++;
      onProgress?.(completed, chunks.length);
    }
  }

  return resultMap;
}
