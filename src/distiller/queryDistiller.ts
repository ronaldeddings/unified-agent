/**
 * Question-driven distiller — given a user question, finds the most relevant
 * conversation chunks via dual search (SQLite FTS + ClaudeMem), re-ranks them
 * with question-aware assessment, and assembles a token-budgeted distilled session.
 *
 * This is the core of Phase 9: the original project goal of creating fresh
 * sessions optimized for answering a specific user question.
 */

import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { Chunk } from "../scoring/chunker.ts";
import type { DefensiveClaudeMemClient } from "../memory/defensiveMem.ts";
import type { AssessmentResult } from "../assessment/assessor.ts";
import { assessChunks } from "../assessment/assessor.ts";
import { computeConsensus } from "../assessment/consensus.ts";
import { buildQuestionAwarePrompt, parseQuestionAwareResponse } from "../assessment/prompts.ts";
import { runStreamingCommand } from "../providers/stream.ts";
import type { DistilledSession, DistillerConfig } from "./distiller.ts";
import { DEFAULT_DISTILLER_CONFIG } from "./distiller.ts";

// ═══════════════════════════════════════════════════════════════════
// Interfaces (Item 94)
// ═══════════════════════════════════════════════════════════════════

export interface QueryDistillConfig extends DistillerConfig {
  question: string;
  searchSources: "chunks" | "claudemem" | "both";
  queryAssessmentWeight: number;
  staticAssessmentWeight: number;
  claudeMemMaxResults: number;
  reRankWithQuestion: boolean;
  providers: ("claude" | "codex" | "gemini")[];
  timeoutMs: number;
  cwd: string;
}

export const DEFAULT_QUERY_DISTILL_CONFIG: QueryDistillConfig = {
  ...DEFAULT_DISTILLER_CONFIG,
  question: "",
  searchSources: "both",
  queryAssessmentWeight: 0.6,
  staticAssessmentWeight: 0.4,
  claudeMemMaxResults: 20,
  reRankWithQuestion: true,
  providers: ["claude", "codex", "gemini"],
  timeoutMs: 30000,
  cwd: process.cwd(),
};

export interface QueryDistillResult extends DistilledSession {
  question: string;
  searchStats: {
    chunkFtsMatches: number;
    claudeMemMatches: number;
    totalCandidates: number;
    afterReRank: number;
  };
}

// ═══════════════════════════════════════════════════════════════════
// Internal types
// ═══════════════════════════════════════════════════════════════════

interface CandidateChunk {
  chunk: Chunk;
  source: "fts" | "claudemem";
  existingConsensus: number;
  questionScore: number;
  contentHash: string;
}

// ═══════════════════════════════════════════════════════════════════
// Item 95: FTS-based chunk search
// ═══════════════════════════════════════════════════════════════════

/**
 * Search the chunk_fts FTS5 table for chunks matching the question.
 * Returns chunk IDs and their content, then loads associated Chunk objects
 * from the chunks table.
 */
export function searchChunksFts(
  db: Database,
  question: string,
  limit: number = 50,
): CandidateChunk[] {
  try {
    // FTS5 MATCH query — tokenize question into search terms
    const searchTerms = question
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 2)
      .join(" OR ");

    if (!searchTerms) return [];

    const rows = db
      .prepare(
        `SELECT chunk_id, content FROM chunk_fts WHERE chunk_fts MATCH ? LIMIT ?`,
      )
      .all(searchTerms, limit) as Array<{ chunk_id: string; content: string }>;

    // Load consensus scores from chunks table
    const candidates: CandidateChunk[] = [];
    for (const row of rows) {
      const chunkMeta = db
        .prepare("SELECT consensus_score, importance_avg, start_event_index, end_event_index, token_count FROM chunks WHERE id = ?")
        .get(row.chunk_id) as {
          consensus_score: number | null;
          importance_avg: number | null;
          start_event_index: number;
          end_event_index: number;
          token_count: number | null;
        } | null;

      const chunk: Chunk = {
        id: row.chunk_id,
        sessionId: "fts_result",
        events: [
          {
            type: "fts_match",
            role: "assistant" as const,
            content: row.content,
            timestamp: new Date().toISOString(),
          },
        ],
        startIndex: chunkMeta?.start_event_index ?? 0,
        endIndex: chunkMeta?.end_event_index ?? 0,
        importanceAvg: chunkMeta?.importance_avg ?? 50,
        tokenEstimate: chunkMeta?.token_count ?? Math.ceil(row.content.length / 4),
      };

      candidates.push({
        chunk,
        source: "fts",
        existingConsensus: chunkMeta?.consensus_score ?? 5.0,
        questionScore: 0,
        contentHash: hashContent(row.content),
      });
    }

    return candidates;
  } catch {
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════════
// Item 96: ClaudeMem-based chunk search
// ═══════════════════════════════════════════════════════════════════

/**
 * Search ClaudeMem for chunks relevant to the question.
 * Uses DefensiveClaudeMemClient.searchAsChunks() to get semantic matches
 * as synthetic Chunk objects.
 */
export async function searchChunksClaudeMem(
  memClient: DefensiveClaudeMemClient,
  question: string,
  maxResults: number = 20,
): Promise<CandidateChunk[]> {
  try {
    const chunks = await memClient.searchAsChunks(question, maxResults);

    return chunks.map((chunk) => ({
      chunk,
      source: "claudemem" as const,
      existingConsensus: chunk.importanceAvg / 10, // Convert 0-100 to 0-10 scale
      questionScore: 0,
      contentHash: hashContent(chunk.events[0]?.content ?? ""),
    }));
  } catch {
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════════
// Item 97: Candidate pool merge and deduplication
// ═══════════════════════════════════════════════════════════════════

/**
 * Merge FTS and ClaudeMem candidates, deduplicating by content hash.
 * When duplicates exist, keeps the one with the higher existing consensus score.
 */
export function mergeCandidates(
  ftsCandidates: CandidateChunk[],
  memCandidates: CandidateChunk[],
): CandidateChunk[] {
  const byHash = new Map<string, CandidateChunk>();

  // Add FTS candidates first
  for (const candidate of ftsCandidates) {
    const existing = byHash.get(candidate.contentHash);
    if (!existing || candidate.existingConsensus > existing.existingConsensus) {
      byHash.set(candidate.contentHash, candidate);
    }
  }

  // Add ClaudeMem candidates, keeping higher-scoring duplicate
  for (const candidate of memCandidates) {
    const existing = byHash.get(candidate.contentHash);
    if (!existing || candidate.existingConsensus > existing.existingConsensus) {
      byHash.set(candidate.contentHash, candidate);
    }
  }

  return [...byHash.values()];
}

// ═══════════════════════════════════════════════════════════════════
// Item 98: Question-aware re-ranking
// ═══════════════════════════════════════════════════════════════════

/** CLI args builder for each provider for question-aware assessment. */
function buildProviderArgs(
  provider: "claude" | "codex" | "gemini",
  prompt: string,
): { cmd: string; args: string[] } {
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
 * Run question-aware assessment for a single chunk against one provider.
 * Returns the question relevance score (overallScore from the question-aware rating).
 */
async function runQuestionAwareAssessment(
  chunk: Chunk,
  question: string,
  provider: "claude" | "codex" | "gemini",
  timeoutMs: number,
  cwd: string,
): Promise<{ provider: string; score: number } | null> {
  const prompt = buildQuestionAwarePrompt(chunk, question);
  const { cmd, args } = buildProviderArgs(provider, prompt);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const { stdout, code } = await runStreamingCommand(cmd, args, cwd, {
      signal: controller.signal,
    });

    if (code !== 0) return null;

    const rating = parseQuestionAwareResponse(stdout);
    if (!rating) return null;

    return { provider, score: rating.overallScore };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Re-rank candidates using question-aware assessment.
 * Spawns provider CLIs to evaluate each chunk against the user's question.
 * Sets the `questionScore` on each candidate.
 */
export async function reRankWithQuestion(
  candidates: CandidateChunk[],
  question: string,
  providers: ("claude" | "codex" | "gemini")[],
  timeoutMs: number,
  cwd: string,
): Promise<CandidateChunk[]> {
  if (candidates.length === 0) return [];

  // Assess each candidate in parallel batches of 3
  const batchSize = 3;
  for (let i = 0; i < candidates.length; i += batchSize) {
    const batch = candidates.slice(i, i + batchSize);

    const batchResults = await Promise.all(
      batch.map(async (candidate) => {
        // Assess with all providers in parallel
        const providerResults = await Promise.all(
          providers.map((provider) =>
            runQuestionAwareAssessment(
              candidate.chunk,
              question,
              provider,
              timeoutMs,
              cwd,
            ),
          ),
        );

        // Compute average score from successful assessments
        const validScores = providerResults
          .filter((r): r is { provider: string; score: number } => r !== null)
          .map((r) => r.score);

        if (validScores.length > 0) {
          candidate.questionScore =
            validScores.reduce((a, b) => a + b, 0) / validScores.length;
        }

        return candidate;
      }),
    );
  }

  return candidates;
}

// ═══════════════════════════════════════════════════════════════════
// Item 99: Question-weighted consensus scoring
// ═══════════════════════════════════════════════════════════════════

/**
 * Compute a final score for each candidate using weighted combination
 * of question-specific relevance and general consensus.
 *
 * finalScore = queryWeight * questionRelevance + staticWeight * existingConsensus
 *
 * Default: 60% question relevance, 40% general importance.
 */
export function computeQuestionWeightedScore(
  candidate: CandidateChunk,
  queryWeight: number = 0.6,
  staticWeight: number = 0.4,
): number {
  // Normalize question score to 0-1 (from 1-10 scale)
  const normalizedQuestion = (candidate.questionScore - 1) / 9;
  // Normalize existing consensus to 0-1 (from 0-10 scale)
  const normalizedConsensus = candidate.existingConsensus / 10;

  return queryWeight * normalizedQuestion + staticWeight * normalizedConsensus;
}

// ═══════════════════════════════════════════════════════════════════
// Item 100: Token-budget selection + main queryDistill()
// ═══════════════════════════════════════════════════════════════════

/**
 * Hash the first 500 characters of content for deduplication.
 */
function hashContent(content: string): string {
  return createHash("sha256").update(content.slice(0, 500)).digest("hex");
}

/**
 * Select top candidates within a token budget, sorted by final score.
 */
function selectWithinBudget(
  candidates: CandidateChunk[],
  maxTokens: number,
  queryWeight: number,
  staticWeight: number,
): { selected: CandidateChunk[]; dropped: number } {
  // Score and sort by question-weighted score descending
  const scored = candidates.map((c) => ({
    candidate: c,
    finalScore: computeQuestionWeightedScore(c, queryWeight, staticWeight),
  }));
  scored.sort((a, b) => b.finalScore - a.finalScore);

  const selected: CandidateChunk[] = [];
  let totalTokens = 0;
  let dropped = 0;

  for (const { candidate } of scored) {
    if (totalTokens + candidate.chunk.tokenEstimate <= maxTokens) {
      selected.push(candidate);
      totalTokens += candidate.chunk.tokenEstimate;
    } else {
      dropped++;
    }
  }

  return { selected, dropped };
}

/**
 * Main entry point: question-driven distillation.
 *
 * Pipeline:
 * 1. Dual search (FTS + ClaudeMem) in parallel
 * 2. Merge + deduplicate candidates
 * 3. Question-aware re-ranking (optional)
 * 4. Question-weighted consensus scoring
 * 5. Token-budget selection
 * 6. Return QueryDistillResult
 */
export async function queryDistill(
  question: string,
  db: Database,
  memClient: DefensiveClaudeMemClient,
  config?: Partial<QueryDistillConfig>,
): Promise<QueryDistillResult> {
  const cfg: QueryDistillConfig = { ...DEFAULT_QUERY_DISTILL_CONFIG, ...config, question };

  // Step 1: Dual search (parallel)
  let ftsCandidates: CandidateChunk[] = [];
  let memCandidates: CandidateChunk[] = [];

  if (cfg.searchSources === "chunks" || cfg.searchSources === "both") {
    ftsCandidates = searchChunksFts(db, question);
  }

  if (cfg.searchSources === "claudemem" || cfg.searchSources === "both") {
    memCandidates = await searchChunksClaudeMem(
      memClient,
      question,
      cfg.claudeMemMaxResults,
    );
  }

  // Step 2: Merge + deduplicate
  const merged = mergeCandidates(ftsCandidates, memCandidates);

  // Step 3: Question-aware re-ranking (optional)
  let reRanked = merged;
  if (cfg.reRankWithQuestion && merged.length > 0) {
    reRanked = await reRankWithQuestion(
      merged,
      question,
      cfg.providers,
      cfg.timeoutMs,
      cfg.cwd,
    );
  }

  // Step 4 + 5: Question-weighted scoring + token-budget selection
  const { selected, dropped } = selectWithinBudget(
    reRanked,
    cfg.maxTokens,
    cfg.queryAssessmentWeight,
    cfg.staticAssessmentWeight,
  );

  // Re-sort selected chunks by startIndex for chronological coherence
  selected.sort((a, b) => a.chunk.startIndex - b.chunk.startIndex);

  // Collect unique session IDs and platforms
  const sessionIds = new Set<string>();
  const platforms = new Set<string>();
  for (const { chunk } of selected) {
    sessionIds.add(chunk.sessionId);
    const platform = (chunk.events[0]?.metadata?.platform as string) ?? "";
    if (platform) platforms.add(platform);
  }

  const totalTokens = selected.reduce((sum, c) => sum + c.chunk.tokenEstimate, 0);

  return {
    question,
    sourceSessionIds: [...sessionIds],
    sourcePlatforms: [...platforms],
    chunks: selected.map((c) => c.chunk),
    totalTokens,
    droppedChunks: dropped,
    distilledAt: new Date().toISOString(),
    searchStats: {
      chunkFtsMatches: ftsCandidates.length,
      claudeMemMatches: memCandidates.length,
      totalCandidates: merged.length,
      afterReRank: reRanked.length,
    },
  };
}
