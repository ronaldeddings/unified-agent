import { describe, expect, test } from "bun:test";
import { parseLine } from "../src/commands/parse";

describe("parseLine — :distill load/unload commands", () => {
  test("parses :distill load with no args", () => {
    const r = parseLine(":distill load");
    expect(r.command).toEqual({
      kind: "distill_load",
      path: undefined,
      cwd: undefined,
    });
  });

  test("parses :distill load with explicit path", () => {
    const r = parseLine(":distill load /path/to/build.jsonl");
    expect(r.command).toEqual({
      kind: "distill_load",
      path: "/path/to/build.jsonl",
      cwd: undefined,
    });
  });

  test("parses :distill load with --cwd flag", () => {
    const r = parseLine(":distill load --cwd /my/project");
    expect(r.command).toEqual({
      kind: "distill_load",
      path: undefined,
      cwd: "/my/project",
    });
  });

  test("parses :distill load with path and --cwd", () => {
    const r = parseLine(":distill load /path/to/build.jsonl --cwd /my/project");
    expect(r.command).toEqual({
      kind: "distill_load",
      path: "/path/to/build.jsonl",
      cwd: "/my/project",
    });
  });

  test("parses :d load (alias)", () => {
    const r = parseLine(":d load");
    expect(r.command).toEqual({
      kind: "distill_load",
      path: undefined,
      cwd: undefined,
    });
  });

  test("parses :distill unload", () => {
    const r = parseLine(":distill unload");
    expect(r.command).toEqual({ kind: "distill_unload" });
  });

  test("parses :d unload (alias)", () => {
    const r = parseLine(":d unload");
    expect(r.command).toEqual({ kind: "distill_unload" });
  });
});
