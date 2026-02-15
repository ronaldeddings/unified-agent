import { describe, expect, test } from "bun:test";
import { codexParser } from "../src/parsers/codexParser.ts";
import type { ParsedEvent } from "../src/parsers/types.ts";

async function collectEvents(source: string): Promise<ParsedEvent[]> {
  const events: ParsedEvent[] = [];
  for await (const event of codexParser.parse(source)) {
    events.push(event);
  }
  return events;
}

describe("codexParser", () => {
  test("platform is codex", () => {
    expect(codexParser.platform).toBe("codex");
  });

  test("detect returns true for .codex paths", () => {
    expect(codexParser.detect("/Users/me/.codex/sessions/abc.jsonl")).toBe(true);
  });

  test("detect returns false for non-codex paths", () => {
    expect(codexParser.detect("/Users/me/.claude/sessions/abc.jsonl")).toBe(false);
    expect(codexParser.detect("/tmp/foo.json")).toBe(false);
  });

  test("parses command_execution item.completed", async () => {
    const line = JSON.stringify({
      type: "item.completed",
      item: {
        type: "command_execution",
        call_id: "call_1",
        name: "shell",
        arguments: "ls -la",
        status: "completed",
        output: [{ type: "text", text: "total 42\ndrwxr-xr-x ..." }],
      },
      timestamp: "2026-02-14T10:00:00Z",
    });

    const events = await collectEvents(line);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("tool_use");
    expect(events[0].role).toBe("tool");
    expect(events[0].toolName).toBe("shell");
    expect(events[0].toolInput).toBe("ls -la");
    expect(events[0].toolOutput).toContain("total 42");
    expect(events[0].isError).toBe(false);
  });

  test("parses function_call item.completed", async () => {
    const line = JSON.stringify({
      type: "item.completed",
      item: {
        type: "function_call",
        call_id: "call_2",
        name: "read_file",
        arguments: JSON.stringify({ path: "/tmp/foo.ts" }),
        status: "completed",
        output: [{ type: "text", text: "file contents" }],
      },
    });

    const events = await collectEvents(line);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("tool_use");
    expect(events[0].toolName).toBe("read_file");
  });

  test("parses failed command_execution", async () => {
    const line = JSON.stringify({
      type: "item.completed",
      item: {
        type: "command_execution",
        name: "shell",
        arguments: "invalid-cmd",
        status: "failed",
        output: [{ type: "text", text: "command not found" }],
      },
    });

    const events = await collectEvents(line);
    expect(events).toHaveLength(1);
    expect(events[0].isError).toBe(true);
  });

  test("parses reasoning item.completed", async () => {
    const line = JSON.stringify({
      type: "item.completed",
      item: {
        type: "reasoning",
        content: [{ type: "text", text: "I need to check the file structure first." }],
      },
    });

    const events = await collectEvents(line);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("reasoning");
    expect(events[0].role).toBe("assistant");
    expect(events[0].content).toBe("I need to check the file structure first.");
  });

  test("parses assistant role item.completed", async () => {
    const line = JSON.stringify({
      type: "item.completed",
      item: {
        role: "assistant",
        content: [{ type: "output_text", text: "Here is the result." }],
      },
    });

    const events = await collectEvents(line);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("assistant");
    expect(events[0].role).toBe("assistant");
    expect(events[0].content).toBe("Here is the result.");
  });

  test("parses user role item.completed", async () => {
    const line = JSON.stringify({
      type: "item.completed",
      item: {
        role: "user",
        content: [{ type: "text", text: "Summarize this code" }],
      },
    });

    const events = await collectEvents(line);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("user");
    expect(events[0].role).toBe("user");
  });

  test("parses turn.completed with usage", async () => {
    const line = JSON.stringify({
      type: "turn.completed",
      response: {
        model: "gpt-5",
        usage: {
          input_tokens: 1000,
          output_tokens: 500,
          total_tokens: 1500,
        },
      },
    });

    const events = await collectEvents(line);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("usage");
    expect(events[0].content).toContain("1000 in");
    expect(events[0].content).toContain("500 out");
    expect(events[0].metadata?.model).toBe("gpt-5");
  });

  test("handles multiple lines", async () => {
    const lines = [
      JSON.stringify({ type: "item.completed", item: { role: "user", content: [{ type: "text", text: "Hello" }] } }),
      JSON.stringify({ type: "item.completed", item: { role: "assistant", content: [{ type: "text", text: "Hi" }] } }),
      JSON.stringify({ type: "turn.completed", response: { usage: { input_tokens: 10, output_tokens: 5 } } }),
    ].join("\n");

    const events = await collectEvents(lines);
    expect(events).toHaveLength(3);
  });

  test("skips empty lines and invalid JSON", async () => {
    const lines = ["", "not json", JSON.stringify({ type: "turn.completed" }), ""].join("\n");
    const events = await collectEvents(lines);
    expect(events).toHaveLength(1);
  });

  test("parses from ReadableStream", async () => {
    const line = JSON.stringify({
      type: "item.completed",
      item: { role: "assistant", content: [{ type: "text", text: "Stream test" }] },
    }) + "\n";

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(line));
        controller.close();
      },
    });

    const events: ParsedEvent[] = [];
    for await (const event of codexParser.parse(stream)) {
      events.push(event);
    }
    expect(events).toHaveLength(1);
    expect(events[0].content).toBe("Stream test");
  });
});
