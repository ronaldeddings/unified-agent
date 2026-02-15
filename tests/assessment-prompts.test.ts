import { describe, expect, test } from "bun:test";
import {
  buildAssessmentPrompt,
  parseAssessmentResponse,
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

describe("buildAssessmentPrompt", () => {
  test("includes chunk event content", () => {
    const chunk = makeChunk({
      events: [
        makeEvent({ content: "Fix the login bug" }),
        makeEvent({ content: "I found the issue in auth.ts" }),
      ],
    });
    const prompt = buildAssessmentPrompt(chunk);
    expect(prompt).toContain("Fix the login bug");
    expect(prompt).toContain("I found the issue in auth.ts");
  });

  test("includes platform label when provided", () => {
    const prompt = buildAssessmentPrompt(makeChunk(), "claude");
    expect(prompt).toContain("from claude session");
  });

  test("uses 'unknown' when no platform provided", () => {
    const prompt = buildAssessmentPrompt(makeChunk());
    expect(prompt).toContain("from unknown session");
  });

  test("includes event count and token estimate", () => {
    const chunk = makeChunk({
      events: [makeEvent(), makeEvent(), makeEvent()],
      tokenEstimate: 500,
    });
    const prompt = buildAssessmentPrompt(chunk);
    expect(prompt).toContain("3 events");
    expect(prompt).toContain("~500 tokens");
  });

  test("includes role labels for events", () => {
    const chunk = makeChunk({
      events: [
        makeEvent({ role: "user", content: "user question" }),
        makeEvent({ role: "assistant", content: "assistant answer" }),
      ],
    });
    const prompt = buildAssessmentPrompt(chunk);
    expect(prompt).toContain("[user]");
    expect(prompt).toContain("[assistant]");
  });

  test("includes tool name when present", () => {
    const chunk = makeChunk({
      events: [makeEvent({ toolName: "Bash", content: "ran a command" })],
    });
    const prompt = buildAssessmentPrompt(chunk);
    expect(prompt).toContain("(tool: Bash)");
  });

  test("requests JSON-only response", () => {
    const prompt = buildAssessmentPrompt(makeChunk());
    expect(prompt).toContain("Respond with ONLY this JSON");
    expect(prompt).toContain('"relevance"');
    expect(prompt).toContain('"signalDensity"');
    expect(prompt).toContain('"reusability"');
    expect(prompt).toContain('"overallScore"');
    expect(prompt).toContain('"rationale"');
  });
});

describe("parseAssessmentResponse", () => {
  test("parses valid JSON response", () => {
    const response = '{"relevance": 8, "signalDensity": 7, "reusability": 9, "overallScore": 8, "rationale": "Good chunk"}';
    const result = parseAssessmentResponse(response);
    expect(result).not.toBeNull();
    expect(result!.relevance).toBe(8);
    expect(result!.signalDensity).toBe(7);
    expect(result!.reusability).toBe(9);
    expect(result!.overallScore).toBe(8);
    expect(result!.rationale).toBe("Good chunk");
  });

  test("parses JSON wrapped in markdown code block", () => {
    const response = '```json\n{"relevance": 6, "signalDensity": 5, "reusability": 7, "overallScore": 6, "rationale": "Average"}\n```';
    const result = parseAssessmentResponse(response);
    expect(result).not.toBeNull();
    expect(result!.overallScore).toBe(6);
  });

  test("parses JSON embedded in extra text", () => {
    const response = 'Here is my assessment:\n{"relevance": 9, "signalDensity": 8, "reusability": 9, "overallScore": 9, "rationale": "Excellent"}';
    const result = parseAssessmentResponse(response);
    expect(result).not.toBeNull();
    expect(result!.overallScore).toBe(9);
  });

  test("returns null for completely invalid response", () => {
    const result = parseAssessmentResponse("I cannot evaluate this chunk.");
    expect(result).toBeNull();
  });

  test("returns null for JSON missing required fields", () => {
    const result = parseAssessmentResponse('{"relevance": 5}');
    expect(result).toBeNull();
  });

  test("clamps scores to 1-10 range", () => {
    const response = '{"relevance": 15, "signalDensity": 0, "reusability": -3, "overallScore": 12, "rationale": "Extreme"}';
    const result = parseAssessmentResponse(response);
    expect(result).not.toBeNull();
    expect(result!.relevance).toBe(10);
    expect(result!.signalDensity).toBe(1);
    expect(result!.reusability).toBe(1);
    expect(result!.overallScore).toBe(10);
  });

  test("handles JSON with whitespace and newlines", () => {
    const response = `{
      "relevance": 7,
      "signalDensity": 6,
      "reusability": 8,
      "overallScore": 7,
      "rationale": "Useful content with some noise"
    }`;
    const result = parseAssessmentResponse(response);
    expect(result).not.toBeNull();
    expect(result!.overallScore).toBe(7);
  });
});
