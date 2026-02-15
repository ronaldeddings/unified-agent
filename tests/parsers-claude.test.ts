import { describe, expect, test } from "bun:test";
import { claudeParser } from "../src/parsers/claudeParser.ts";
import type { ParsedEvent } from "../src/parsers/types.ts";

async function collectEvents(source: string): Promise<ParsedEvent[]> {
  const events: ParsedEvent[] = [];
  for await (const event of claudeParser.parse(source)) {
    events.push(event);
  }
  return events;
}

describe("claudeParser", () => {
  test("platform is claude", () => {
    expect(claudeParser.platform).toBe("claude");
  });

  test("detect returns true for .claude paths", () => {
    expect(claudeParser.detect("/Users/me/.claude/projects/foo/sessions/abc.jsonl")).toBe(true);
    expect(claudeParser.detect("/home/user/.claude/projects/bar/123.jsonl")).toBe(true);
  });

  test("detect returns false for non-claude paths", () => {
    expect(claudeParser.detect("/Users/me/.codex/sessions/abc.jsonl")).toBe(false);
    expect(claudeParser.detect("/tmp/random.json")).toBe(false);
  });

  test("parses assistant message with text content", async () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "text", text: "Hello, world!" }],
        model: "claude-sonnet-4-20250514",
        stop_reason: "end_turn",
      },
      timestamp: "2026-02-14T10:00:00Z",
    });

    const events = await collectEvents(line);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("assistant");
    expect(events[0].role).toBe("assistant");
    expect(events[0].content).toBe("Hello, world!");
    expect(events[0].timestamp).toBe("2026-02-14T10:00:00Z");
    expect(events[0].metadata?.model).toBe("claude-sonnet-4-20250514");
  });

  test("parses assistant message with tool_use blocks", async () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Let me read that file." },
          { type: "tool_use", id: "tu_1", name: "Read", input: { path: "/tmp/foo.ts" } },
        ],
        model: "claude-sonnet-4-20250514",
      },
    });

    const events = await collectEvents(line);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("assistant");
    expect(events[0].content).toBe("Let me read that file.");
    expect(events[0].toolName).toBe("Read");
    expect(events[0].toolInput).toBe(JSON.stringify({ path: "/tmp/foo.ts" }));
  });

  test("parses user message with tool_result blocks", async () => {
    const line = JSON.stringify({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu_1",
            content: "file contents here",
          },
        ],
      },
    });

    const events = await collectEvents(line);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("tool_result");
    expect(events[0].role).toBe("tool");
    expect(events[0].toolOutput).toBe("file contents here");
  });

  test("parses user message with tool_result error", async () => {
    const line = JSON.stringify({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu_2",
            content: "File not found",
            is_error: true,
          },
        ],
      },
    });

    const events = await collectEvents(line);
    expect(events).toHaveLength(1);
    expect(events[0].isError).toBe(true);
  });

  test("parses plain user message", async () => {
    const line = JSON.stringify({
      type: "user",
      message: {
        content: [{ type: "text", text: "What is this project?" }],
      },
    });

    const events = await collectEvents(line);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("user");
    expect(events[0].role).toBe("user");
    expect(events[0].content).toBe("What is this project?");
  });

  test("parses system event", async () => {
    const line = JSON.stringify({
      type: "system",
      message: {
        content: [{ type: "text", text: "Session started" }],
      },
      timestamp: "2026-02-14T10:00:00Z",
    });

    const events = await collectEvents(line);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("system");
    expect(events[0].role).toBe("system");
    expect(events[0].content).toBe("Session started");
  });

  test("parses summary event", async () => {
    const line = JSON.stringify({
      type: "summary",
      message: {
        content: [{ type: "text", text: "Compacted context" }],
      },
      subtype: "auto_compact",
    });

    const events = await collectEvents(line);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("summary");
    expect(events[0].role).toBe("system");
    expect(events[0].metadata?.subtype).toBe("auto_compact");
  });

  test("handles multiple lines", async () => {
    const lines = [
      JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "Hello" }] } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Hi!" }] } }),
      JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "Bye" }] } }),
    ].join("\n");

    const events = await collectEvents(lines);
    expect(events).toHaveLength(3);
    expect(events[0].content).toBe("Hello");
    expect(events[1].content).toBe("Hi!");
    expect(events[2].content).toBe("Bye");
  });

  test("skips empty lines and invalid JSON", async () => {
    const lines = [
      "",
      "not json",
      JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "Valid" }] } }),
      "",
    ].join("\n");

    const events = await collectEvents(lines);
    expect(events).toHaveLength(1);
    expect(events[0].content).toBe("Valid");
  });

  test("parses from ReadableStream", async () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "Streamed!" }] },
    }) + "\n";

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(line));
        controller.close();
      },
    });

    const events: ParsedEvent[] = [];
    for await (const event of claudeParser.parse(stream)) {
      events.push(event);
    }
    expect(events).toHaveLength(1);
    expect(events[0].content).toBe("Streamed!");
  });

  test("preserves rawLine on each event", async () => {
    const raw = JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "raw" }] } });
    const events = await collectEvents(raw);
    expect(events[0].rawLine).toBe(raw);
  });

  test("handles unknown event types gracefully", async () => {
    const line = JSON.stringify({ type: "custom_hook", data: "something" });
    const events = await collectEvents(line);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("custom_hook");
  });
});
