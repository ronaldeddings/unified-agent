import { describe, expect, test } from "bun:test";
import {
  buildQuestionAwarePrompt,
  parseQuestionAwareResponse,
} from "../src/assessment/prompts.ts";
import type { Chunk } from "../src/scoring/chunker.ts";
import type { ParsedEvent } from "../src/parsers/types.ts";

function makeEvent(overrides: Partial<ParsedEvent> = {}): ParsedEvent {
  return {
    type: "assistant",
    role: "assistant",
    content: "Hello world",
    ...overrides,
  };
}

function makeChunk(overrides: Partial<Chunk> = {}): Chunk {
  return {
    id: "chunk_001",
    sessionId: "session_001",
    events: [makeEvent()],
    startIndex: 0,
    endIndex: 0,
    importanceAvg: 50,
    tokenEstimate: 100,
    ...overrides,
  };
}

describe("buildQuestionAwarePrompt", () => {
  test("includes the user's question", () => {
    const prompt = buildQuestionAwarePrompt(
      makeChunk(),
      "How does the adapter pattern work?",
    );
    expect(prompt).toContain("How does the adapter pattern work?");
  });

  test("includes 'Question the user wants to answer' header", () => {
    const prompt = buildQuestionAwarePrompt(makeChunk(), "test question");
    expect(prompt).toContain("Question the user wants to answer");
  });

  test("includes chunk event content", () => {
    const chunk = makeChunk({
      events: [
        makeEvent({ content: "The adapter normalizes events" }),
        makeEvent({ content: "Each provider has its own format" }),
      ],
    });
    const prompt = buildQuestionAwarePrompt(chunk, "How do adapters work?");
    expect(prompt).toContain("The adapter normalizes events");
    expect(prompt).toContain("Each provider has its own format");
  });

  test("includes platform label when provided", () => {
    const prompt = buildQuestionAwarePrompt(makeChunk(), "test", "claude");
    expect(prompt).toContain("from claude session");
  });

  test("uses 'unknown' when no platform provided", () => {
    const prompt = buildQuestionAwarePrompt(makeChunk(), "test");
    expect(prompt).toContain("from unknown session");
  });

  test("includes event count and token estimate", () => {
    const chunk = makeChunk({
      events: [makeEvent(), makeEvent(), makeEvent()],
      tokenEstimate: 750,
    });
    const prompt = buildQuestionAwarePrompt(chunk, "test");
    expect(prompt).toContain("3 events");
    expect(prompt).toContain("~750 tokens");
  });

  test("includes role labels for events", () => {
    const chunk = makeChunk({
      events: [
        makeEvent({ role: "user", content: "user question" }),
        makeEvent({ role: "assistant", content: "assistant answer" }),
      ],
    });
    const prompt = buildQuestionAwarePrompt(chunk, "test");
    expect(prompt).toContain("[user]");
    expect(prompt).toContain("[assistant]");
  });

  test("includes tool name when present", () => {
    const chunk = makeChunk({
      events: [makeEvent({ toolName: "Read", content: "read a file" })],
    });
    const prompt = buildQuestionAwarePrompt(chunk, "test");
    expect(prompt).toContain("(tool: Read)");
  });

  test("requests JSON response with question-aware schema", () => {
    const prompt = buildQuestionAwarePrompt(makeChunk(), "test");
    expect(prompt).toContain("Respond with ONLY this JSON");
    expect(prompt).toContain('"questionRelevance"');
    expect(prompt).toContain('"signalDensity"');
    expect(prompt).toContain('"contextValue"');
    expect(prompt).toContain('"overallScore"');
    expect(prompt).toContain('"rationale"');
  });

  test("rates on Question Relevance instead of Reusability", () => {
    const prompt = buildQuestionAwarePrompt(makeChunk(), "test");
    expect(prompt).toContain("Question Relevance");
    expect(prompt).not.toContain("Reusability");
  });

  test("rates on Context Value instead of generic Relevance", () => {
    const prompt = buildQuestionAwarePrompt(makeChunk(), "test");
    expect(prompt).toContain("Context Value");
  });
});

describe("parseQuestionAwareResponse", () => {
  test("parses valid JSON response", () => {
    const response =
      '{"questionRelevance": 8, "signalDensity": 7, "contextValue": 9, "overallScore": 8, "rationale": "Directly relevant"}';
    const result = parseQuestionAwareResponse(response);
    expect(result).not.toBeNull();
    expect(result!.questionRelevance).toBe(8);
    expect(result!.signalDensity).toBe(7);
    expect(result!.contextValue).toBe(9);
    expect(result!.overallScore).toBe(8);
    expect(result!.rationale).toBe("Directly relevant");
  });

  test("parses JSON wrapped in markdown code block", () => {
    const response =
      '```json\n{"questionRelevance": 6, "signalDensity": 5, "contextValue": 7, "overallScore": 6, "rationale": "Somewhat relevant"}\n```';
    const result = parseQuestionAwareResponse(response);
    expect(result).not.toBeNull();
    expect(result!.overallScore).toBe(6);
  });

  test("parses JSON embedded in extra text", () => {
    const response =
      'Here is my assessment:\n{"questionRelevance": 9, "signalDensity": 8, "contextValue": 9, "overallScore": 9, "rationale": "Excellent match"}';
    const result = parseQuestionAwareResponse(response);
    expect(result).not.toBeNull();
    expect(result!.overallScore).toBe(9);
  });

  test("returns null for completely invalid response", () => {
    const result = parseQuestionAwareResponse("I cannot evaluate this chunk.");
    expect(result).toBeNull();
  });

  test("returns null for JSON missing required fields", () => {
    const result = parseQuestionAwareResponse('{"questionRelevance": 5}');
    expect(result).toBeNull();
  });

  test("returns null for generic assessment schema (wrong fields)", () => {
    const response =
      '{"relevance": 8, "signalDensity": 7, "reusability": 9, "overallScore": 8, "rationale": "Good"}';
    const result = parseQuestionAwareResponse(response);
    expect(result).toBeNull();
  });

  test("clamps scores to 1-10 range", () => {
    const response =
      '{"questionRelevance": 15, "signalDensity": 0, "contextValue": -3, "overallScore": 12, "rationale": "Extreme"}';
    const result = parseQuestionAwareResponse(response);
    expect(result).not.toBeNull();
    expect(result!.questionRelevance).toBe(10);
    expect(result!.signalDensity).toBe(1);
    expect(result!.contextValue).toBe(1);
    expect(result!.overallScore).toBe(10);
  });

  test("handles JSON with whitespace and newlines", () => {
    const response = `{
      "questionRelevance": 7,
      "signalDensity": 6,
      "contextValue": 8,
      "overallScore": 7,
      "rationale": "Provides useful background context"
    }`;
    const result = parseQuestionAwareResponse(response);
    expect(result).not.toBeNull();
    expect(result!.overallScore).toBe(7);
    expect(result!.contextValue).toBe(8);
  });
});
