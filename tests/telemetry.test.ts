import { describe, expect, test } from "bun:test";
import { isMcpToolName, summarizeToolInput, summarizeToolOutput } from "../src/providers/telemetry";

describe("telemetry formatters", () => {
  test("summarizes common tool input fields", () => {
    const v = summarizeToolInput({
      command: "ls -1 | head -3",
      file_path: "/tmp/a.txt",
      dir_path: "/tmp",
    });
    expect(v).toContain('cmd="ls -1 | head -3"');
    expect(v).toContain('file="/tmp/a.txt"');
    expect(v).toContain('dir="/tmp"');
  });

  test("summarizes tool output strings and objects", () => {
    expect(summarizeToolOutput("line1\nline2")).toContain("line1 line2");
    const obj = summarizeToolOutput({ stdout: "ok", exit_code: 0, status: "success" });
    expect(obj).toContain('stdout="ok"');
    expect(obj).toContain("exit=0");
    expect(obj).toContain('status="success"');
  });

  test("detects mcp tool names", () => {
    expect(isMcpToolName("mcp__context7__query-docs")).toBe(true);
    expect(isMcpToolName("Bash")).toBe(false);
  });
});

