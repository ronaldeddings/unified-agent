import { describe, expect, test } from "bun:test";
import { parseLine } from "../src/commands/parse";

describe("parseLine", () => {
  test("parses user text", () => {
    const r = parseLine("hello");
    expect(r.userText).toBe("hello");
  });

  test("parses :provider", () => {
    const r = parseLine(":provider codex");
    expect(r.command).toEqual({ kind: "provider", provider: "codex" });
  });

  test("parses :model", () => {
    const r = parseLine(":model gpt-5");
    expect(r.command).toEqual({ kind: "model", model: "gpt-5" });
  });

  test("parses :model auto as provider default", () => {
    const r = parseLine(":model auto");
    expect(r.command).toEqual({ kind: "model", model: undefined });
  });

  test("parses :session resume", () => {
    const r = parseLine(":session resume ms_abc");
    expect(r.command).toEqual({ kind: "session_resume", id: "ms_abc" });
  });

  test("parses :mem stats", () => {
    const r = parseLine(":mem stats");
    expect(r.command).toEqual({ kind: "mem_stats" });
  });

  test("parses :mem note", () => {
    const r = parseLine(":mem note hello");
    expect(r.command).toEqual({ kind: "mem_note", text: "hello" });
  });

  test("parses :context mode", () => {
    const r = parseLine(":context mode full");
    expect(r.command).toEqual({ kind: "context_mode", mode: "full" });
  });

  test("parses :context turns", () => {
    const r = parseLine(":context turns 24");
    expect(r.command).toEqual({ kind: "context_turns", turns: 24 });
  });
});
