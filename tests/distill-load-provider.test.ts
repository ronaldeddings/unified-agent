import { describe, expect, test } from "bun:test";
import { buildClaudeArgs } from "../src/providers/claudeCli";

describe("buildClaudeArgs — resumePath support", () => {
  test("includes --resume when resumePath is provided", () => {
    const args = buildClaudeArgs("hello", {
      resumePath: "/path/to/build.jsonl",
      permissionMode: "default",
    });
    expect(args).toContain("--resume");
    expect(args).toContain("/path/to/build.jsonl");
    const resumeIdx = args.indexOf("--resume");
    expect(args[resumeIdx + 1]).toBe("/path/to/build.jsonl");
  });

  test("does not include --resume when resumePath is not provided", () => {
    const args = buildClaudeArgs("hello", { permissionMode: "default" });
    expect(args).not.toContain("--resume");
  });

  test("does not include --resume when resumePath is undefined", () => {
    const args = buildClaudeArgs("hello", { resumePath: undefined, permissionMode: "default" });
    expect(args).not.toContain("--resume");
  });

  test("--resume appears before the prompt", () => {
    const args = buildClaudeArgs("my prompt text", {
      resumePath: "/build.jsonl",
      permissionMode: "default",
    });
    const resumeIdx = args.indexOf("--resume");
    const promptIdx = args.indexOf("my prompt text");
    expect(resumeIdx).toBeLessThan(promptIdx);
  });

  test("--resume works alongside other flags", () => {
    const args = buildClaudeArgs("prompt", {
      resumePath: "/build.jsonl",
      model: "claude-sonnet-4-5-20250929",
      permissionMode: "bypassPermissions",
    });
    expect(args).toContain("--resume");
    expect(args).toContain("--model");
    expect(args).toContain("--dangerously-skip-permissions");
    expect(args).toContain("-p");
    // prompt is last
    expect(args[args.length - 1]).toBe("prompt");
  });
});
