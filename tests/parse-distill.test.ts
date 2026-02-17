import { describe, expect, test } from "bun:test";
import { parseLine } from "../src/commands/parse";

describe("parseLine — :distill commands", () => {
  test("parses :distill scan", () => {
    const r = parseLine(":distill scan");
    expect(r.command).toEqual({ kind: "distill_scan" });
  });

  test("parses :d scan (alias)", () => {
    const r = parseLine(":d scan");
    expect(r.command).toEqual({ kind: "distill_scan" });
  });

  test("parses :distill status", () => {
    const r = parseLine(":distill status");
    expect(r.command).toEqual({ kind: "distill_status" });
  });

  test("parses :distill run with no args", () => {
    const r = parseLine(":distill run");
    expect(r.command).toEqual({
      kind: "distill_run",
      sessionIds: undefined,
      providers: undefined,
    });
  });

  test("parses :distill run with session IDs", () => {
    const r = parseLine(":distill run ms_abc ms_def");
    expect(r.command).toEqual({
      kind: "distill_run",
      sessionIds: ["ms_abc", "ms_def"],
      providers: undefined,
    });
  });

  test("parses :distill run with --providers flag", () => {
    const r = parseLine(":distill run --providers claude,codex");
    expect(r.command).toEqual({
      kind: "distill_run",
      sessionIds: undefined,
      providers: ["claude", "codex"],
    });
  });

  test("parses :distill run with session IDs and --providers", () => {
    const r = parseLine(":distill run ms_abc --providers claude,gemini");
    expect(r.command).toEqual({
      kind: "distill_run",
      sessionIds: ["ms_abc"],
      providers: ["claude", "gemini"],
    });
  });

  test("parses :distill seed claude", () => {
    const r = parseLine(":distill seed claude");
    expect(r.command).toEqual({
      kind: "distill_seed",
      platform: "claude",
      sessionId: undefined,
    });
  });

  test("parses :distill seed codex with session ID", () => {
    const r = parseLine(":distill seed codex ms_abc");
    expect(r.command).toEqual({
      kind: "distill_seed",
      platform: "codex",
      sessionId: "ms_abc",
    });
  });

  test("parses :distill seed gemini", () => {
    const r = parseLine(":distill seed gemini");
    expect(r.command).toEqual({
      kind: "distill_seed",
      platform: "gemini",
      sessionId: undefined,
    });
  });

  test("rejects :distill seed with invalid platform", () => {
    const r = parseLine(":distill seed invalid");
    expect(r.command).toEqual({ kind: "help" });
  });

  test("parses :distill query with text", () => {
    const r = parseLine(":distill query adapter pattern");
    expect(r.command).toEqual({
      kind: "distill_query",
      query: "adapter pattern",
    });
  });

  test("rejects :distill query with no text", () => {
    const r = parseLine(":distill query");
    expect(r.command).toEqual({ kind: "help" });
  });

  test("parses :distill report with no session ID", () => {
    const r = parseLine(":distill report");
    expect(r.command).toEqual({
      kind: "distill_report",
      sessionId: undefined,
    });
  });

  test("parses :distill report with session ID", () => {
    const r = parseLine(":distill report ms_abc");
    expect(r.command).toEqual({
      kind: "distill_report",
      sessionId: "ms_abc",
    });
  });

  test("parses :distill assess with no chunk ID", () => {
    const r = parseLine(":distill assess");
    expect(r.command).toEqual({
      kind: "distill_assess",
      chunkId: undefined,
    });
  });

  test("parses :distill assess with chunk ID", () => {
    const r = parseLine(":distill assess chunk_abc");
    expect(r.command).toEqual({
      kind: "distill_assess",
      chunkId: "chunk_abc",
    });
  });

  test("parses :distill watch on", () => {
    const r = parseLine(":distill watch on");
    expect(r.command).toEqual({ kind: "distill_watch", enabled: true });
  });

  test("parses :distill watch off", () => {
    const r = parseLine(":distill watch off");
    expect(r.command).toEqual({ kind: "distill_watch", enabled: false });
  });

  test("parses :distill watch true", () => {
    const r = parseLine(":distill watch true");
    expect(r.command).toEqual({ kind: "distill_watch", enabled: true });
  });

  test("rejects :distill watch with invalid arg", () => {
    const r = parseLine(":distill watch maybe");
    expect(r.command).toEqual({ kind: "help" });
  });

  test('parses :distill ask with double-quoted question', () => {
    const r = parseLine(':distill ask "How does the adapter pattern work?"');
    expect(r.command).toEqual({
      kind: "distill_ask",
      question: "How does the adapter pattern work?",
      platform: undefined,
      providers: undefined,
    });
  });

  test("parses :distill ask with single-quoted question", () => {
    const r = parseLine(":distill ask 'What files changed?'");
    expect(r.command).toEqual({
      kind: "distill_ask",
      question: "What files changed?",
      platform: undefined,
      providers: undefined,
    });
  });

  test("parses :distill ask with --platform flag", () => {
    const r = parseLine(':distill ask "question here" --platform codex');
    expect(r.command).toEqual({
      kind: "distill_ask",
      question: "question here",
      platform: "codex",
      providers: undefined,
    });
  });

  test("parses :distill ask with --providers flag", () => {
    const r = parseLine(':distill ask "question" --providers claude,gemini');
    expect(r.command).toEqual({
      kind: "distill_ask",
      question: "question",
      platform: undefined,
      providers: ["claude", "gemini"],
    });
  });

  test("parses :distill ask with both flags", () => {
    const r = parseLine(':distill ask "question" --platform claude --providers claude,codex,gemini');
    expect(r.command).toEqual({
      kind: "distill_ask",
      question: "question",
      platform: "claude",
      providers: ["claude", "codex", "gemini"],
    });
  });

  test("parses :distill ask with unquoted question and flags", () => {
    const r = parseLine(":distill ask how does it work --platform claude");
    expect(r.command).toEqual({
      kind: "distill_ask",
      question: "how does it work",
      platform: "claude",
      providers: undefined,
    });
  });

  test("rejects :distill ask with no question", () => {
    const r = parseLine(":distill ask");
    expect(r.command).toEqual({ kind: "help" });
  });

  test("rejects :distill with unknown subcommand", () => {
    const r = parseLine(":distill unknown");
    expect(r.command).toEqual({ kind: "help" });
  });

  test("rejects :distill with no subcommand", () => {
    const r = parseLine(":distill");
    expect(r.command).toEqual({ kind: "help" });
  });

  // 10.22: Tests for new --cwd, --limit, --budget, --output flags

  test("parses :distill run with --cwd flag", () => {
    const r = parseLine(":distill run --cwd /Volumes/VRAM/project");
    expect(r.command?.kind).toBe("distill_run");
    if (r.command?.kind === "distill_run") {
      expect(r.command.cwd).toBe("/Volumes/VRAM/project");
      expect(r.command.sessionIds).toBeUndefined();
    }
  });

  test("parses :distill run with --limit flag", () => {
    const r = parseLine(":distill run --limit 20");
    expect(r.command?.kind).toBe("distill_run");
    if (r.command?.kind === "distill_run") {
      expect(r.command.limit).toBe(20);
    }
  });

  test("parses :distill run with --budget flag", () => {
    const r = parseLine(":distill run --budget 80000");
    expect(r.command?.kind).toBe("distill_run");
    if (r.command?.kind === "distill_run") {
      expect(r.command.budget).toBe(80000);
    }
  });

  test("parses :distill run with --output flag", () => {
    const r = parseLine(":distill run --output /tmp/out.jsonl");
    expect(r.command?.kind).toBe("distill_run");
    if (r.command?.kind === "distill_run") {
      expect(r.command.output).toBe("/tmp/out.jsonl");
    }
  });

  test("parses :distill run with all flags combined", () => {
    const r = parseLine(":distill run --cwd /path/to/proj --limit 10 --budget 50000 --output /tmp/out.jsonl --providers claude,codex");
    expect(r.command?.kind).toBe("distill_run");
    if (r.command?.kind === "distill_run") {
      expect(r.command.cwd).toBe("/path/to/proj");
      expect(r.command.limit).toBe(10);
      expect(r.command.budget).toBe(50000);
      expect(r.command.output).toBe("/tmp/out.jsonl");
      expect(r.command.providers).toEqual(["claude", "codex"]);
    }
  });

  test("parses :distill run with session IDs and flags", () => {
    const r = parseLine(":distill run ms_abc --cwd /proj --limit 5");
    expect(r.command?.kind).toBe("distill_run");
    if (r.command?.kind === "distill_run") {
      expect(r.command.sessionIds).toEqual(["ms_abc"]);
      expect(r.command.cwd).toBe("/proj");
      expect(r.command.limit).toBe(5);
    }
  });

  test("parses :distill ask with --cwd and --limit flags", () => {
    const r = parseLine(':distill ask "What patterns exist?" --cwd /proj --limit 15');
    expect(r.command?.kind).toBe("distill_ask");
    if (r.command?.kind === "distill_ask") {
      expect(r.command.question).toBe("What patterns exist?");
      expect(r.command.cwd).toBe("/proj");
      expect(r.command.limit).toBe(15);
    }
  });

  test("parses :distill ask with --budget flag", () => {
    const r = parseLine(':distill ask "question" --budget 40000');
    expect(r.command?.kind).toBe("distill_ask");
    if (r.command?.kind === "distill_ask") {
      expect(r.command.budget).toBe(40000);
    }
  });

  test("ignores invalid --limit value", () => {
    const r = parseLine(":distill run --limit abc");
    expect(r.command?.kind).toBe("distill_run");
    if (r.command?.kind === "distill_run") {
      expect(r.command.limit).toBeUndefined();
    }
  });

  // 13.1-13.2: distill build command parsing
  test("parses :distill build with all flags", () => {
    const r = parseLine(":distill build --cwd /my/project --limit 10 --budget 50000 --format conversation --providers claude,codex");
    expect(r.command?.kind).toBe("distill_build");
    if (r.command?.kind === "distill_build") {
      expect(r.command.cwd).toBe("/my/project");
      expect(r.command.limit).toBe(10);
      expect(r.command.budget).toBe(50000);
      expect(r.command.format).toBe("conversation");
      expect(r.command.providers).toEqual(["claude", "codex"]);
      expect(r.command.dryRun).toBeUndefined();
    }
  });

  test("parses :distill build --dry-run", () => {
    const r = parseLine(":distill build --cwd /test --dry-run");
    expect(r.command?.kind).toBe("distill_build");
    if (r.command?.kind === "distill_build") {
      expect(r.command.cwd).toBe("/test");
      expect(r.command.dryRun).toBe(true);
    }
  });

  test("parses :distill build with no flags", () => {
    const r = parseLine(":distill build");
    expect(r.command?.kind).toBe("distill_build");
    if (r.command?.kind === "distill_build") {
      expect(r.command.cwd).toBeUndefined();
      expect(r.command.limit).toBeUndefined();
      expect(r.command.budget).toBeUndefined();
    }
  });

  test("parses :d build (alias)", () => {
    const r = parseLine(":d build --cwd /test");
    expect(r.command?.kind).toBe("distill_build");
    if (r.command?.kind === "distill_build") {
      expect(r.command.cwd).toBe("/test");
    }
  });

  // 13.16: distill preview as alias for build --dry-run
  test("parses :distill preview as build --dry-run", () => {
    const r = parseLine(":distill preview --cwd /test --limit 5");
    expect(r.command?.kind).toBe("distill_build");
    if (r.command?.kind === "distill_build") {
      expect(r.command.dryRun).toBe(true);
      expect(r.command.cwd).toBe("/test");
      expect(r.command.limit).toBe(5);
    }
  });
});
