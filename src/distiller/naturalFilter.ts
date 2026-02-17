/**
 * Natural Language Filter — Phase 14
 *
 * Accepts free-form text describing desired distillation scope
 * and converts it into structured DistillFilterParams by spawning
 * a provider CLI with a structured extraction prompt.
 *
 * Example input:
 *   "conversations last two weeks that contain the keyword 'railway'
 *    and '/Volumes/VRAM/.../hvm-website-payloadcms/' only most recent 20"
 *
 * Example output:
 *   { cwd: "/Volumes/VRAM/.../hvm-website-payloadcms/", limit: 20,
 *     since: "2026-02-02", keywords: ["railway"] }
 */

import { runStreamingCommand } from "../providers/stream.ts";

// ─── 14.1 DistillFilterParams Interface ─────────────────────────────────────

export interface DistillFilterParams {
  /** Project directory path to scope sessions. */
  cwd?: string;
  /** Maximum number of sessions to process. */
  limit?: number;
  /** Only include sessions modified on or after this ISO date (YYYY-MM-DD). */
  since?: string;
  /** Only include sessions modified on or before this ISO date (YYYY-MM-DD). */
  until?: string;
  /** Keywords to filter chunks by (FTS search on chunk content). */
  keywords?: string[];
  /** Providers to use for assessment. */
  providers?: string[];
  /** Token budget for distilled output. */
  budget?: number;
  /** Output format. */
  format?: "conversation" | "summary";
}

// ─── 14.3 Filter Extraction Prompt ──────────────────────────────────────────

/**
 * Build the structured prompt that tells the LLM about available filter
 * dimensions and requests JSON output.
 */
export function buildFilterExtractionPrompt(naturalLanguage: string, today: string): string {
  return `You are a filter extraction assistant. Given a natural language description of desired session scope, extract structured filter parameters as JSON.

Available filter dimensions:
- cwd (string): Absolute path to a project directory. Extract any file paths mentioned.
- limit (number): Maximum number of sessions. Look for phrases like "most recent N", "top N", "last N".
- since (string, YYYY-MM-DD): Start date. Convert relative dates like "last two weeks" to absolute dates. Today is ${today}.
- until (string, YYYY-MM-DD): End date. Convert relative dates to absolute dates. Today is ${today}.
- keywords (string[]): Content search terms. Look for phrases like "contain keyword X", "about X", "mentioning X".
- providers (string[]): Valid values are "claude", "codex", "gemini". Only include if explicitly mentioned.
- budget (number): Token budget. Look for phrases like "budget of N tokens", "N tokens".
- format (string): Either "conversation" or "summary". Only include if explicitly mentioned.

Rules:
- Only include fields that are clearly specified or implied in the input.
- For relative dates: "last two weeks" means since = today minus 14 days. "last month" means since = today minus 30 days.
- For paths: preserve the exact path as written, including any leading slash.
- For keywords: extract individual words or short phrases that are search terms.
- Output ONLY valid JSON, no markdown fences, no explanation.

Input: "${naturalLanguage.replace(/"/g, '\\"')}"

JSON output:`;
}

// ─── 14.4 Parse LLM Response ────────────────────────────────────────────────

/**
 * Parse the LLM's response into DistillFilterParams.
 * Handles plain JSON, markdown-wrapped JSON (```json ... ```), and
 * extracts from surrounding text if needed.
 */
export function parseFilterResponse(llmOutput: string): DistillFilterParams {
  const trimmed = llmOutput.trim();

  // Try direct JSON parse first
  try {
    return validateFilterParams(JSON.parse(trimmed));
  } catch {
    // Continue to fallback strategies
  }

  // Try extracting from markdown code fence
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) {
    try {
      return validateFilterParams(JSON.parse(fenceMatch[1].trim()));
    } catch {
      // Continue
    }
  }

  // Try finding first { ... } block in the output
  const braceMatch = trimmed.match(/\{[\s\S]*\}/);
  if (braceMatch) {
    try {
      return validateFilterParams(JSON.parse(braceMatch[0]));
    } catch {
      // Continue
    }
  }

  // All parsing strategies failed — return empty params
  return {};
}

/**
 * Validate and sanitize raw parsed JSON into a clean DistillFilterParams.
 * Drops unknown fields and coerces types.
 */
function validateFilterParams(raw: unknown): DistillFilterParams {
  if (!raw || typeof raw !== "object") return {};

  const obj = raw as Record<string, unknown>;
  const params: DistillFilterParams = {};

  if (typeof obj.cwd === "string" && obj.cwd.length > 0) {
    params.cwd = obj.cwd;
  }

  if (typeof obj.limit === "number" && obj.limit > 0) {
    params.limit = Math.floor(obj.limit);
  } else if (typeof obj.limit === "string") {
    const n = parseInt(obj.limit, 10);
    if (n > 0) params.limit = n;
  }

  if (typeof obj.since === "string" && /^\d{4}-\d{2}-\d{2}/.test(obj.since)) {
    params.since = obj.since.slice(0, 10);
  }

  if (typeof obj.until === "string" && /^\d{4}-\d{2}-\d{2}/.test(obj.until)) {
    params.until = obj.until.slice(0, 10);
  }

  if (Array.isArray(obj.keywords)) {
    params.keywords = obj.keywords
      .filter((k): k is string => typeof k === "string" && k.length > 0)
      .map((k) => k.toLowerCase());
  }

  if (Array.isArray(obj.providers)) {
    const valid = ["claude", "codex", "gemini"];
    params.providers = obj.providers.filter(
      (p): p is string => typeof p === "string" && valid.includes(p),
    );
    if (params.providers.length === 0) delete params.providers;
  }

  if (typeof obj.budget === "number" && obj.budget > 0) {
    params.budget = Math.floor(obj.budget);
  }

  if (obj.format === "conversation" || obj.format === "summary") {
    params.format = obj.format;
  }

  return params;
}

// ─── 14.5 Extract Filters via Provider CLI ──────────────────────────────────

/** Build CLI args for a provider to run one-shot filter extraction. */
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
        args: ["exec", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", "--ephemeral", prompt],
      };
    case "gemini":
      return {
        cmd: "gemini",
        args: ["-p", prompt, "--yolo"],
      };
  }
}

/**
 * Extract filter parameters from natural language by spawning a provider CLI.
 *
 * @param naturalLanguage - Free-form text describing desired scope
 * @param provider - Which provider CLI to use for extraction (default: claude)
 * @param timeoutMs - Timeout for the CLI call (default: 15000)
 * @returns Parsed DistillFilterParams
 */
export async function extractFilters(
  naturalLanguage: string,
  provider: "claude" | "codex" | "gemini" = "claude",
  timeoutMs = 45000,
): Promise<DistillFilterParams> {
  const today = new Date().toISOString().slice(0, 10);
  const prompt = buildFilterExtractionPrompt(naturalLanguage, today);
  const { cmd, args } = buildProviderArgs(provider, prompt);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const { stdout, code } = await runStreamingCommand(cmd, args, process.cwd(), {
      signal: controller.signal,
    });

    if (code !== 0) {
      console.log(`  ⚠️  Filter extraction failed (exit code ${code}), using empty filters`);
      return {};
    }

    const params = parseFilterResponse(stdout);
    return params;
  } catch {
    console.log("  ⚠️  Filter extraction timed out, using empty filters");
    return {};
  } finally {
    clearTimeout(timer);
  }
}
