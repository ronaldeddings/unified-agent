import { describe, expect, test } from "bun:test";
import { geminiParser } from "../src/parsers/geminiParser.ts";
import type { ParsedEvent } from "../src/parsers/types.ts";

async function collectEvents(source: string): Promise<ParsedEvent[]> {
  const events: ParsedEvent[] = [];
  for await (const event of geminiParser.parse(source)) {
    events.push(event);
  }
  return events;
}

describe("geminiParser", () => {
  test("platform is gemini", () => {
    expect(geminiParser.platform).toBe("gemini");
  });

  test("detect returns true for .gemini JSON paths", () => {
    expect(geminiParser.detect("/Users/me/.gemini/sessions/abc.json")).toBe(true);
    expect(geminiParser.detect("/home/user/.gemini/sessions/xyz.jsonl")).toBe(true);
  });

  test("detect returns false for non-gemini paths", () => {
    expect(geminiParser.detect("/Users/me/.claude/sessions/abc.jsonl")).toBe(false);
    expect(geminiParser.detect("/tmp/random.json")).toBe(false);
  });

  test("parses assistant message with content.parts", async () => {
    const data = JSON.stringify([
      {
        content: {
          role: "model",
          parts: [{ text: "Hello from Gemini!" }],
        },
        timestamp: "2026-02-14T10:00:00Z",
      },
    ]);

    const events = await collectEvents(data);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("assistant");
    expect(events[0].role).toBe("assistant");
    expect(events[0].content).toBe("Hello from Gemini!");
  });

  test("parses user message with content.parts", async () => {
    const data = JSON.stringify([
      {
        content: {
          role: "user",
          parts: [{ text: "What is this?" }],
        },
      },
    ]);

    const events = await collectEvents(data);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("user");
    expect(events[0].role).toBe("user");
    expect(events[0].content).toBe("What is this?");
  });

  test("parses function call in parts", async () => {
    const data = JSON.stringify([
      {
        content: {
          role: "model",
          parts: [
            { text: "Let me check." },
            {
              functionCall: {
                name: "read_file",
                args: { path: "/tmp/foo.ts" },
              },
            },
          ],
        },
      },
    ]);

    const events = await collectEvents(data);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("tool_call");
    expect(events[0].role).toBe("assistant");
    expect(events[0].toolName).toBe("read_file");
    expect(events[0].toolInput).toBe(JSON.stringify({ path: "/tmp/foo.ts" }));
  });

  test("parses function response in parts", async () => {
    const data = JSON.stringify([
      {
        content: {
          role: "user",
          parts: [
            {
              functionResponse: {
                name: "read_file",
                response: { content: "file data here" },
              },
            },
          ],
        },
      },
    ]);

    const events = await collectEvents(data);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("tool_result");
    expect(events[0].role).toBe("tool");
    expect(events[0].toolName).toBe("read_file");
  });

  test("parses typed message events", async () => {
    const line = JSON.stringify({
      type: "message",
      role: "assistant",
      content: "Direct message content",
    });

    const events = await collectEvents(line);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("assistant");
    expect(events[0].content).toBe("Direct message content");
  });

  test("parses typed tool_call events", async () => {
    const line = JSON.stringify({
      type: "tool_call",
      name: "execute_bash",
      args: { command: "ls" },
    });

    const events = await collectEvents(line);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("tool_call");
    expect(events[0].toolName).toBe("execute_bash");
  });

  test("parses typed tool_use events", async () => {
    const line = JSON.stringify({
      type: "tool_use",
      name: "write_file",
      args: { path: "/tmp/out.txt", content: "data" },
    });

    const events = await collectEvents(line);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("tool_call");
    expect(events[0].toolName).toBe("write_file");
  });

  test("parses typed tool_result events", async () => {
    const line = JSON.stringify({
      type: "tool_result",
      name: "execute_bash",
      result: { output: "success" },
    });

    const events = await collectEvents(line);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("tool_result");
    expect(events[0].toolName).toBe("execute_bash");
  });

  test("parses JSON array with multiple entries", async () => {
    const data = JSON.stringify([
      { content: { role: "user", parts: [{ text: "Q1" }] } },
      { content: { role: "model", parts: [{ text: "A1" }] } },
      { content: { role: "user", parts: [{ text: "Q2" }] } },
    ]);

    const events = await collectEvents(data);
    expect(events).toHaveLength(3);
    expect(events[0].content).toBe("Q1");
    expect(events[1].content).toBe("A1");
    expect(events[2].content).toBe("Q2");
  });

  test("parses direct parts on entry (alternative format)", async () => {
    const data = JSON.stringify([
      {
        role: "model",
        parts: [{ text: "Direct parts" }],
      },
    ]);

    const events = await collectEvents(data);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("assistant");
    expect(events[0].content).toBe("Direct parts");
  });

  test("handles JSONL fallback for non-array input", async () => {
    const lines = [
      JSON.stringify({ type: "message", role: "assistant", content: "Line 1" }),
      JSON.stringify({ type: "message", role: "user", content: "Line 2" }),
    ].join("\n");

    const events = await collectEvents(lines);
    expect(events).toHaveLength(2);
  });

  test("skips invalid JSON lines gracefully", async () => {
    const lines = [
      "not json at all",
      JSON.stringify({ type: "message", role: "assistant", content: "Valid" }),
    ].join("\n");

    const events = await collectEvents(lines);
    expect(events).toHaveLength(1);
    expect(events[0].content).toBe("Valid");
  });

  test("parses from ReadableStream", async () => {
    const data = JSON.stringify([
      { content: { role: "model", parts: [{ text: "Streamed!" }] } },
    ]);

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(data));
        controller.close();
      },
    });

    const events: ParsedEvent[] = [];
    for await (const event of geminiParser.parse(stream)) {
      events.push(event);
    }
    expect(events).toHaveLength(1);
    expect(events[0].content).toBe("Streamed!");
  });
});
