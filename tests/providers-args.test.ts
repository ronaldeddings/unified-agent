import { describe, expect, test } from "bun:test";
import { buildClaudeArgs } from "../src/providers/claudeCli";
import { buildCodexArgs } from "../src/providers/codexCli";
import { buildGeminiArgs, buildGeminiModelCandidates, isGeminiFallbackEligibleError } from "../src/providers/geminiCli";

describe("provider arg builders", () => {
  test("claude always includes dangerously-skip-permissions", () => {
    const args = buildClaudeArgs("hello");
    expect(args).toContain("--dangerously-skip-permissions");
    expect(args).toContain("--output-format");
    expect(args).toContain("stream-json");
    expect(args).toContain("--verbose");
  });

  test("claude passes explicit --model", () => {
    const args = buildClaudeArgs("hello", "claude-sonnet-4-20250514");
    const idx = args.indexOf("--model");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("claude-sonnet-4-20250514");
  });

  test("codex always includes dangerously-bypass-approvals-and-sandbox", () => {
    const args = buildCodexArgs("/tmp/out.txt", "hello");
    expect(args).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(args).toContain("--json");
  });

  test("codex passes explicit --model", () => {
    const args = buildCodexArgs("/tmp/out.txt", "hello", "gpt-5");
    const idx = args.indexOf("--model");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("gpt-5");
  });

  test("gemini always includes yolo", () => {
    const args = buildGeminiArgs("hello");
    expect(args).toContain("--yolo");
    expect(args).toContain("--output-format");
    expect(args).toContain("stream-json");
  });

  test("gemini passes explicit --model", () => {
    const args = buildGeminiArgs("hello", "gemini-2.5-pro");
    const idx = args.indexOf("--model");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("gemini-2.5-pro");
  });

  test("gemini model candidates prefer explicit then fallbacks", () => {
    const candidates = buildGeminiModelCandidates("gemini-2.5-pro", "gemini-2.5-flash,auto");
    expect(candidates).toEqual(["gemini-2.5-pro", "gemini-2.5-flash", undefined]);
  });

  test("gemini model candidates use preview-first defaults", () => {
    const candidates = buildGeminiModelCandidates(undefined, undefined);
    expect(candidates).toEqual(["gemini-3-flash-preview", "gemini-2.5-flash", "gemini-2.5-pro", undefined]);
  });

  test("gemini capacity errors are fallback-eligible", () => {
    expect(isGeminiFallbackEligibleError("No capacity available for model gemini-3-flash-preview")).toBe(true);
    expect(isGeminiFallbackEligibleError("MODEL_CAPACITY_EXHAUSTED")).toBe(true);
    expect(isGeminiFallbackEligibleError("status 429 Too Many Requests")).toBe(true);
    expect(isGeminiFallbackEligibleError("syntax error in prompt")).toBe(false);
  });
});
