import { describe, expect, test } from "bun:test";
import {
  detectParser,
  detectParserByContent,
  detectParserByPath,
  getParser,
} from "../src/parsers/index.ts";

describe("parser auto-detection", () => {
  describe("detectParserByPath", () => {
    test("detects Claude from .claude path", () => {
      const parser = detectParserByPath("/Users/me/.claude/projects/foo/sessions/abc.jsonl");
      expect(parser?.platform).toBe("claude");
    });

    test("detects Codex from .codex path", () => {
      const parser = detectParserByPath("/Users/me/.codex/sessions/abc.jsonl");
      expect(parser?.platform).toBe("codex");
    });

    test("detects Gemini from .gemini path", () => {
      const parser = detectParserByPath("/Users/me/.gemini/sessions/abc.json");
      expect(parser?.platform).toBe("gemini");
    });

    test("returns null for unknown paths", () => {
      expect(detectParserByPath("/tmp/random.txt")).toBeNull();
      expect(detectParserByPath("/Users/me/.unknown/sessions/abc.jsonl")).toBeNull();
    });
  });

  describe("detectParserByContent", () => {
    test("detects Claude from assistant message with message field", () => {
      const line = JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "Hello" }] },
      });
      expect(detectParserByContent(line)?.platform).toBe("claude");
    });

    test("detects Claude from user message with content", () => {
      const line = JSON.stringify({
        type: "user",
        content: [{ type: "text", text: "Hi" }],
      });
      expect(detectParserByContent(line)?.platform).toBe("claude");
    });

    test("detects Claude from system event", () => {
      const line = JSON.stringify({ type: "system" });
      expect(detectParserByContent(line)?.platform).toBe("claude");
    });

    test("detects Claude from summary event", () => {
      const line = JSON.stringify({ type: "summary", subtype: "compact" });
      expect(detectParserByContent(line)?.platform).toBe("claude");
    });

    test("detects Codex from item.completed", () => {
      const line = JSON.stringify({
        type: "item.completed",
        item: { type: "reasoning", content: [] },
      });
      expect(detectParserByContent(line)?.platform).toBe("codex");
    });

    test("detects Codex from turn.completed", () => {
      const line = JSON.stringify({
        type: "turn.completed",
        response: { usage: {} },
      });
      expect(detectParserByContent(line)?.platform).toBe("codex");
    });

    test("detects Gemini from JSON array", () => {
      const content = JSON.stringify([{ content: { role: "model", parts: [] } }]);
      expect(detectParserByContent(content)?.platform).toBe("gemini");
    });

    test("detects Gemini from typed message event", () => {
      const line = JSON.stringify({ type: "message", role: "assistant", content: "Hello" });
      expect(detectParserByContent(line)?.platform).toBe("gemini");
    });

    test("detects Gemini from content with parts", () => {
      const line = JSON.stringify({
        content: { parts: [{ text: "Hello" }] },
      });
      expect(detectParserByContent(line)?.platform).toBe("gemini");
    });

    test("detects Gemini from direct parts array", () => {
      const line = JSON.stringify({ parts: [{ text: "Hello" }] });
      expect(detectParserByContent(line)?.platform).toBe("gemini");
    });

    test("detects Gemini from tool_call type", () => {
      const line = JSON.stringify({ type: "tool_call", name: "foo" });
      expect(detectParserByContent(line)?.platform).toBe("gemini");
    });

    test("detects Gemini from tool_result type", () => {
      const line = JSON.stringify({ type: "tool_result", name: "foo" });
      expect(detectParserByContent(line)?.platform).toBe("gemini");
    });

    test("returns null for empty string", () => {
      expect(detectParserByContent("")).toBeNull();
    });

    test("returns null for invalid JSON", () => {
      expect(detectParserByContent("not json")).toBeNull();
    });

    test("returns null for unrecognized JSON structure", () => {
      const line = JSON.stringify({ foo: "bar", baz: 42 });
      expect(detectParserByContent(line)).toBeNull();
    });
  });

  describe("detectParser (combined)", () => {
    test("path takes priority over content", () => {
      const claudeLine = JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "Hi" }] },
      });
      // Path says codex, content says claude — path wins
      const parser = detectParser("/Users/me/.codex/sessions/abc.jsonl", claudeLine);
      expect(parser?.platform).toBe("codex");
    });

    test("falls back to content when path unknown", () => {
      const codexLine = JSON.stringify({
        type: "item.completed",
        item: { type: "reasoning", content: [] },
      });
      const parser = detectParser("/tmp/unknown.jsonl", codexLine);
      expect(parser?.platform).toBe("codex");
    });

    test("returns null when neither matches", () => {
      expect(detectParser("/tmp/random.txt")).toBeNull();
    });
  });

  describe("getParser", () => {
    test("returns claude parser", () => {
      expect(getParser("claude").platform).toBe("claude");
    });

    test("returns codex parser", () => {
      expect(getParser("codex").platform).toBe("codex");
    });

    test("returns gemini parser", () => {
      expect(getParser("gemini").platform).toBe("gemini");
    });
  });
});
