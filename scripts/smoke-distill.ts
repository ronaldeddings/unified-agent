#!/usr/bin/env bun
/**
 * Distillation smoke test.
 *
 * Validates the full pipeline end-to-end using mock data:
 * scan → parse → score → chunk → distill → generate output
 *
 * Does NOT call external provider CLIs — uses deterministic mock data only.
 */

import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { claudeParser } from "../src/parsers/claudeParser.ts";
import { codexParser } from "../src/parsers/codexParser.ts";
import { geminiParser } from "../src/parsers/geminiParser.ts";
import { scoreEvent } from "../src/scoring/importance.ts";
import { buildChunks } from "../src/scoring/chunker.ts";
import { distill } from "../src/distiller/distiller.ts";
import { getGenerator } from "../src/output/index.ts";
import type { ParsedEvent } from "../src/parsers/types.ts";

// --- Mock session data ---

const MOCK_CLAUDE_SESSION = [
  JSON.stringify({ type: "user", content: "How do I fix the bug in auth.ts?", timestamp: "2026-01-15T10:00:00Z" }),
  JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "The bug is in the token validation. Here's the fix:\n```typescript\nif (!token) return false;\n```" }], model: "claude-sonnet-4-5-20250929" }, timestamp: "2026-01-15T10:00:05Z" }),
  JSON.stringify({ type: "user", content: [{ type: "tool_result", tool_use_id: "edit_1", content: "File saved successfully" }], timestamp: "2026-01-15T10:00:10Z" }),
  JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "The fix has been applied. The token validation now correctly rejects empty tokens." }], model: "claude-sonnet-4-5-20250929" }, timestamp: "2026-01-15T10:00:15Z" }),
].join("\n");

const MOCK_CODEX_SESSION = [
  JSON.stringify({ type: "item.completed", item: { role: "user", content: [{ type: "text", text: "List all files in src/" }] }, timestamp: "2026-01-15T11:00:00Z" }),
  JSON.stringify({ type: "item.completed", item: { type: "command_execution", name: "shell", arguments: "ls src/", output: [{ type: "output_text", text: "cli.ts\nrepl.ts\nsession/" }], status: "completed" }, timestamp: "2026-01-15T11:00:05Z" }),
  JSON.stringify({ type: "item.completed", item: { role: "assistant", content: [{ type: "text", text: "The src/ directory contains cli.ts, repl.ts, and a session/ subdirectory." }] }, timestamp: "2026-01-15T11:00:10Z" }),
].join("\n");

const MOCK_GEMINI_SESSION = JSON.stringify([
  { type: "message", role: "user", content: "What is the project structure?", timestamp: "2026-01-15T12:00:00Z" },
  { type: "message", role: "assistant", content: "The project uses a standard TypeScript layout with src/, tests/, and scripts/ directories.", timestamp: "2026-01-15T12:00:05Z" },
  { type: "tool_call", name: "read_file", args: { path: "package.json" }, timestamp: "2026-01-15T12:00:10Z" },
  { type: "tool_result", name: "read_file", result: { content: "{}" }, timestamp: "2026-01-15T12:00:12Z" },
]);

// --- Smoke test ---

interface SmokeResult {
  step: string;
  ok: boolean;
  detail?: string;
}

async function main(): Promise<void> {
  const results: SmokeResult[] = [];
  const tmpDir = await mkdtemp(join(tmpdir(), "distill-smoke-"));

  // Step 1: Parse Claude session
  const claudeEvents: ParsedEvent[] = [];
  for await (const event of claudeParser.parse(MOCK_CLAUDE_SESSION)) {
    claudeEvents.push(event);
  }
  results.push({
    step: "parse_claude",
    ok: claudeEvents.length === 4,
    detail: `${claudeEvents.length} events parsed`,
  });

  // Step 2: Parse Codex session
  const codexEvents: ParsedEvent[] = [];
  for await (const event of codexParser.parse(MOCK_CODEX_SESSION)) {
    codexEvents.push(event);
  }
  results.push({
    step: "parse_codex",
    ok: codexEvents.length === 3,
    detail: `${codexEvents.length} events parsed`,
  });

  // Step 3: Parse Gemini session
  const geminiEvents: ParsedEvent[] = [];
  for await (const event of geminiParser.parse(MOCK_GEMINI_SESSION)) {
    geminiEvents.push(event);
  }
  results.push({
    step: "parse_gemini",
    ok: geminiEvents.length === 4,
    detail: `${geminiEvents.length} events parsed`,
  });

  // Step 4: Score events
  const allEvents = [...claudeEvents, ...codexEvents, ...geminiEvents];
  const scores = allEvents.map((e) => scoreEvent(e));
  const validScores = scores.every((s) => s >= 0 && s <= 100);
  results.push({
    step: "score_events",
    ok: validScores && scores.length === allEvents.length,
    detail: `${scores.length} events scored, range: ${Math.min(...scores)}-${Math.max(...scores)}`,
  });

  // Step 5: Build chunks
  const chunks = buildChunks(allEvents, "smoke-session", {
    minImportanceThreshold: 20,
    maxEventsPerChunk: 5,
  });
  results.push({
    step: "build_chunks",
    ok: chunks.length > 0,
    detail: `${chunks.length} chunks built`,
  });

  // Step 6: Distill (using mock consensus scores)
  const scoredChunks = new Map<string, { chunk: typeof chunks[0]; consensus: number }>();
  for (const chunk of chunks) {
    scoredChunks.set(chunk.id, { chunk, consensus: 7.5 });
  }
  const distilled = distill(scoredChunks, { minConsensusScore: 5.0 });
  results.push({
    step: "distill",
    ok: distilled.chunks.length > 0 && distilled.totalTokens > 0,
    detail: `${distilled.chunks.length} chunks selected, ${distilled.totalTokens} tokens`,
  });

  // Step 7: Generate Claude output
  const claudeOutPath = join(tmpDir, "claude-output.jsonl");
  await getGenerator("claude").generate(distilled, claudeOutPath);
  const claudeOutput = await Bun.file(claudeOutPath).text();
  const claudeLines = claudeOutput.trim().split("\n").filter(Boolean);
  const claudeValid = claudeLines.every((l) => {
    try { JSON.parse(l); return true; } catch { return false; }
  });
  results.push({
    step: "generate_claude",
    ok: claudeValid && claudeLines.length > 0,
    detail: `${claudeLines.length} JSONL lines, valid JSON: ${claudeValid}`,
  });

  // Step 8: Generate Codex output
  const codexOutPath = join(tmpDir, "codex-output.jsonl");
  await getGenerator("codex").generate(distilled, codexOutPath);
  const codexOutput = await Bun.file(codexOutPath).text();
  const codexLines = codexOutput.trim().split("\n").filter(Boolean);
  const codexValid = codexLines.every((l) => {
    try { JSON.parse(l); return true; } catch { return false; }
  });
  results.push({
    step: "generate_codex",
    ok: codexValid && codexLines.length > 0,
    detail: `${codexLines.length} JSONL lines, valid JSON: ${codexValid}`,
  });

  // Step 9: Generate Gemini output
  const geminiOutPath = join(tmpDir, "gemini-output.json");
  await getGenerator("gemini").generate(distilled, geminiOutPath);
  const geminiOutput = await Bun.file(geminiOutPath).text();
  let geminiValid = false;
  try {
    const parsed = JSON.parse(geminiOutput);
    geminiValid = parsed.metadata && Array.isArray(parsed.contents);
  } catch { /* invalid */ }
  results.push({
    step: "generate_gemini",
    ok: geminiValid,
    detail: `valid Gemini JSON: ${geminiValid}`,
  });

  // Print results
  const allPassed = results.every((r) => r.ok);
  console.log(JSON.stringify({ passed: allPassed, tmpDir, results }, null, 2));

  if (!allPassed) {
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
