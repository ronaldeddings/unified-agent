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
});
