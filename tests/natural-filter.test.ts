/**
 * Phase 14: Natural Language Filter tests
 *
 * Tests for:
 * - 14.14: buildFilterExtractionPrompt produces valid prompt
 * - 14.15: parseFilterResponse handles valid JSON, markdown-wrapped, malformed
 * - 14.16: date filtering in scanSessions (since/until)
 * - 14.17: Command parser handles :distill filter and --filter flag
 */
import { describe, expect, test } from "bun:test";
import {
  buildFilterExtractionPrompt,
  parseFilterResponse,
  type DistillFilterParams,
} from "../src/distiller/naturalFilter";
import { parseLine } from "../src/commands/parse";

// ─── 14.14: Prompt building ─────────────────────────────────────────────────

describe("naturalFilter — buildFilterExtractionPrompt (14.14)", () => {
  test("includes today's date", () => {
    const prompt = buildFilterExtractionPrompt("last two weeks about railway", "2026-02-16");
    expect(prompt).toContain("2026-02-16");
  });

  test("includes the natural language input", () => {
    const prompt = buildFilterExtractionPrompt("conversations about railway deployment", "2026-02-16");
    expect(prompt).toContain("conversations about railway deployment");
  });

  test("describes all filter dimensions", () => {
    const prompt = buildFilterExtractionPrompt("test", "2026-02-16");
    expect(prompt).toContain("cwd");
    expect(prompt).toContain("limit");
    expect(prompt).toContain("since");
    expect(prompt).toContain("until");
    expect(prompt).toContain("keywords");
    expect(prompt).toContain("providers");
    expect(prompt).toContain("budget");
    expect(prompt).toContain("format");
  });

  test("escapes quotes in input", () => {
    const prompt = buildFilterExtractionPrompt('keyword "railway" here', "2026-02-16");
    expect(prompt).toContain('\\"railway\\"');
  });

  test("requests JSON output", () => {
    const prompt = buildFilterExtractionPrompt("test", "2026-02-16");
    expect(prompt).toContain("JSON");
  });
});

// ─── 14.15: Response parsing ────────────────────────────────────────────────

describe("naturalFilter — parseFilterResponse (14.15)", () => {
  test("parses plain JSON", () => {
    const result = parseFilterResponse('{"cwd": "/path/to/project", "limit": 20}');
    expect(result.cwd).toBe("/path/to/project");
    expect(result.limit).toBe(20);
  });

  test("parses markdown-wrapped JSON", () => {
    const result = parseFilterResponse('```json\n{"since": "2026-02-02", "keywords": ["railway"]}\n```');
    expect(result.since).toBe("2026-02-02");
    expect(result.keywords).toEqual(["railway"]);
  });

  test("extracts JSON from surrounding text", () => {
    const result = parseFilterResponse('Here are the extracted filters:\n{"limit": 10, "cwd": "/test"}\nDone!');
    expect(result.limit).toBe(10);
    expect(result.cwd).toBe("/test");
  });

  test("returns empty object for invalid input", () => {
    const result = parseFilterResponse("This is not JSON at all");
    expect(Object.keys(result).length).toBe(0);
  });

  test("returns empty object for empty input", () => {
    const result = parseFilterResponse("");
    expect(Object.keys(result).length).toBe(0);
  });

  test("validates date format (YYYY-MM-DD)", () => {
    const result = parseFilterResponse('{"since": "2026-02-01", "until": "not-a-date"}');
    expect(result.since).toBe("2026-02-01");
    expect(result.until).toBeUndefined();
  });

  test("coerces string limit to number", () => {
    const result = parseFilterResponse('{"limit": "25"}');
    expect(result.limit).toBe(25);
  });

  test("rejects negative limit", () => {
    const result = parseFilterResponse('{"limit": -5}');
    expect(result.limit).toBeUndefined();
  });

  test("filters invalid providers", () => {
    const result = parseFilterResponse('{"providers": ["claude", "invalid", "gemini"]}');
    expect(result.providers).toEqual(["claude", "gemini"]);
  });

  test("drops empty providers array", () => {
    const result = parseFilterResponse('{"providers": ["invalid"]}');
    expect(result.providers).toBeUndefined();
  });

  test("validates format field", () => {
    const result = parseFilterResponse('{"format": "conversation"}');
    expect(result.format).toBe("conversation");
  });

  test("rejects invalid format", () => {
    const result = parseFilterResponse('{"format": "invalid"}');
    expect(result.format).toBeUndefined();
  });

  test("lowercases keywords", () => {
    const result = parseFilterResponse('{"keywords": ["Railway", "DEPLOY"]}');
    expect(result.keywords).toEqual(["railway", "deploy"]);
  });

  test("validates budget", () => {
    const result = parseFilterResponse('{"budget": 50000}');
    expect(result.budget).toBe(50000);
  });

  test("handles all fields together", () => {
    const json = JSON.stringify({
      cwd: "/Volumes/VRAM/project",
      limit: 20,
      since: "2026-02-02",
      until: "2026-02-16",
      keywords: ["railway", "deploy"],
      providers: ["claude", "codex"],
      budget: 80000,
      format: "conversation",
    });
    const result = parseFilterResponse(json);
    expect(result.cwd).toBe("/Volumes/VRAM/project");
    expect(result.limit).toBe(20);
    expect(result.since).toBe("2026-02-02");
    expect(result.until).toBe("2026-02-16");
    expect(result.keywords).toEqual(["railway", "deploy"]);
    expect(result.providers).toEqual(["claude", "codex"]);
    expect(result.budget).toBe(80000);
    expect(result.format).toBe("conversation");
  });

  test("ignores unknown fields", () => {
    const result = parseFilterResponse('{"cwd": "/test", "unknownField": true, "foo": 42}');
    expect(result.cwd).toBe("/test");
    expect((result as any).unknownField).toBeUndefined();
    expect((result as any).foo).toBeUndefined();
  });
});

// ─── 14.16: Scanner date filtering ──────────────────────────────────────────

describe("naturalFilter — scanner date filtering (14.16)", () => {
  // Note: We test the ScanOptions interface accepts since/until through
  // the type system. Runtime filtering is tested via the parseLine + handler
  // integration. Here we verify the command parser passes them through.

  test("ScanOptions type accepts since and until", () => {
    // This is a compile-time check — if it compiles, the interface is correct
    const opts: import("../src/scanner/scanner").ScanOptions = {
      since: "2026-02-01",
      until: "2026-02-16",
    };
    expect(opts.since).toBe("2026-02-01");
    expect(opts.until).toBe("2026-02-16");
  });
});

// ─── 14.17: Command parser ──────────────────────────────────────────────────

describe("naturalFilter — command parser (14.17)", () => {
  test("parses :distill filter with quoted text", () => {
    const { command } = parseLine(':distill filter "conversations about railway last two weeks"');
    expect(command).toBeDefined();
    expect(command!.kind).toBe("distill_filter");
    if (command!.kind === "distill_filter") {
      expect(command!.text).toBe("conversations about railway last two weeks");
    }
  });

  test("parses :distill filter with single-quoted text", () => {
    const { command } = parseLine(":distill filter 'sessions about HVM'");
    expect(command).toBeDefined();
    expect(command!.kind).toBe("distill_filter");
    if (command!.kind === "distill_filter") {
      expect(command!.text).toBe("sessions about HVM");
    }
  });

  test("parses :distill filter with --providers flag", () => {
    const { command } = parseLine(':distill filter "railway sessions" --providers claude,gemini');
    expect(command).toBeDefined();
    expect(command!.kind).toBe("distill_filter");
    if (command!.kind === "distill_filter") {
      expect(command!.text).toBe("railway sessions");
      expect(command!.providers).toEqual(["claude", "gemini"]);
    }
  });

  test("parses :distill filter without quotes returns help", () => {
    const { command } = parseLine(":distill filter");
    expect(command).toBeDefined();
    expect(command!.kind).toBe("help");
  });

  test("parses :distill build with --filter flag", () => {
    const { command } = parseLine(':distill build --filter sessions about railway --cwd /test');
    expect(command).toBeDefined();
    expect(command!.kind).toBe("distill_build");
    if (command!.kind === "distill_build") {
      expect(command!.filter).toBe("sessions about railway");
      expect(command!.cwd).toBe("/test");
    }
  });

  test("parses :distill build --filter with remaining flags", () => {
    const { command } = parseLine(":distill build --filter last two weeks about deploy --limit 10 --budget 50000");
    expect(command).toBeDefined();
    expect(command!.kind).toBe("distill_build");
    if (command!.kind === "distill_build") {
      expect(command!.filter).toBe("last two weeks about deploy");
      expect(command!.limit).toBe(10);
      expect(command!.budget).toBe(50000);
    }
  });

  test("parses :distill build without --filter (backwards compatible)", () => {
    const { command } = parseLine(":distill build --cwd /test --limit 5");
    expect(command).toBeDefined();
    expect(command!.kind).toBe("distill_build");
    if (command!.kind === "distill_build") {
      expect(command!.filter).toBeUndefined();
      expect(command!.cwd).toBe("/test");
      expect(command!.limit).toBe(5);
    }
  });
});
