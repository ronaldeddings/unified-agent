import { describe, expect, test } from "bun:test";
import { scoreEvent, DEFAULT_SCORING_CONFIG } from "../src/scoring/importance.ts";
import type { ParsedEvent } from "../src/parsers/types.ts";

function makeEvent(overrides: Partial<ParsedEvent> = {}): ParsedEvent {
  return {
    type: "assistant",
    role: "assistant",
    content: "Hello world",
    ...overrides,
  };
}

describe("scoreEvent", () => {
  test("returns base score for a plain assistant message", () => {
    const score = scoreEvent(makeEvent());
    expect(score).toBe(DEFAULT_SCORING_CONFIG.baseScore);
  });

  test("adds toolUseBonus when toolName is present", () => {
    const score = scoreEvent(makeEvent({ toolName: "Bash" }));
    expect(score).toBe(DEFAULT_SCORING_CONFIG.baseScore + DEFAULT_SCORING_CONFIG.toolUseBonus);
  });

  test("adds toolUseBonus when toolInput is present", () => {
    const score = scoreEvent(makeEvent({ toolInput: '{"cmd": "ls"}' }));
    expect(score).toBe(DEFAULT_SCORING_CONFIG.baseScore + DEFAULT_SCORING_CONFIG.toolUseBonus);
  });

  test("adds errorBonus when isError is true", () => {
    const score = scoreEvent(makeEvent({ isError: true }));
    expect(score).toBe(DEFAULT_SCORING_CONFIG.baseScore + DEFAULT_SCORING_CONFIG.errorBonus);
  });

  test("adds userPromptBonus for user role (non-tool_result)", () => {
    const score = scoreEvent(makeEvent({ role: "user", type: "user" }));
    expect(score).toBe(DEFAULT_SCORING_CONFIG.baseScore + DEFAULT_SCORING_CONFIG.userPromptBonus);
  });

  test("does NOT add userPromptBonus for tool_result type even with user role", () => {
    const score = scoreEvent(makeEvent({ role: "user", type: "tool_result" }));
    expect(score).toBe(DEFAULT_SCORING_CONFIG.baseScore);
  });

  test("adds codeBlockBonus when content has triple backticks", () => {
    const score = scoreEvent(makeEvent({ content: "Here is code:\n```ts\nconsole.log('hi');\n```" }));
    expect(score).toBe(DEFAULT_SCORING_CONFIG.baseScore + DEFAULT_SCORING_CONFIG.codeBlockBonus);
  });

  test("adds fileEditBonus for Edit tool", () => {
    const score = scoreEvent(makeEvent({ toolName: "Edit" }));
    // Should get both toolUseBonus AND fileEditBonus
    expect(score).toBe(
      DEFAULT_SCORING_CONFIG.baseScore +
      DEFAULT_SCORING_CONFIG.toolUseBonus +
      DEFAULT_SCORING_CONFIG.fileEditBonus
    );
  });

  test("adds fileEditBonus for Write tool", () => {
    const score = scoreEvent(makeEvent({ toolName: "Write" }));
    expect(score).toBe(
      DEFAULT_SCORING_CONFIG.baseScore +
      DEFAULT_SCORING_CONFIG.toolUseBonus +
      DEFAULT_SCORING_CONFIG.fileEditBonus
    );
  });

  test("adds fileEditBonus for NotebookEdit tool", () => {
    const score = scoreEvent(makeEvent({ toolName: "NotebookEdit" }));
    expect(score).toBe(
      DEFAULT_SCORING_CONFIG.baseScore +
      DEFAULT_SCORING_CONFIG.toolUseBonus +
      DEFAULT_SCORING_CONFIG.fileEditBonus
    );
  });

  test("applies longContentPenalty for content > 2000 chars", () => {
    const longContent = "x".repeat(2001);
    const score = scoreEvent(makeEvent({ content: longContent }));
    expect(score).toBe(DEFAULT_SCORING_CONFIG.baseScore + DEFAULT_SCORING_CONFIG.longContentPenalty);
  });

  test("no longContentPenalty for content exactly 2000 chars", () => {
    const content = "x".repeat(2000);
    const score = scoreEvent(makeEvent({ content }));
    expect(score).toBe(DEFAULT_SCORING_CONFIG.baseScore);
  });

  test("applies systemEventPenalty for system role", () => {
    const score = scoreEvent(makeEvent({ role: "system", type: "system" }));
    expect(score).toBe(DEFAULT_SCORING_CONFIG.baseScore + DEFAULT_SCORING_CONFIG.systemEventPenalty);
  });

  test("applies systemEventPenalty for system type even without system role", () => {
    const score = scoreEvent(makeEvent({ type: "system" }));
    expect(score).toBe(DEFAULT_SCORING_CONFIG.baseScore + DEFAULT_SCORING_CONFIG.systemEventPenalty);
  });

  test("applies hookEventPenalty for hook event types", () => {
    const score = scoreEvent(makeEvent({ type: "hook_pre_tool" }));
    expect(score).toBe(DEFAULT_SCORING_CONFIG.baseScore + DEFAULT_SCORING_CONFIG.hookEventPenalty);
  });

  test("applies hookEventPenalty for custom_hook event types", () => {
    const score = scoreEvent(makeEvent({ type: "custom_hook" }));
    expect(score).toBe(DEFAULT_SCORING_CONFIG.baseScore + DEFAULT_SCORING_CONFIG.hookEventPenalty);
  });

  test("cumulates multiple bonuses", () => {
    const event = makeEvent({
      role: "user",
      type: "user",
      toolName: "Edit",
      isError: true,
      content: "Fix this:\n```ts\nconst x = 1;\n```",
    });
    const score = scoreEvent(event);
    // base(50) + toolUse(15) + error(20) + userPrompt(10) + codeBlock(10) + fileEdit(12) = 117 → clamped to 100
    expect(score).toBe(100);
  });

  test("cumulates multiple penalties", () => {
    const event = makeEvent({
      role: "system",
      type: "hook_startup",
      content: "x".repeat(2001),
    });
    const score = scoreEvent(event);
    // base(50) + longContent(-5) + system(-20) + hook(-15) = 10
    expect(score).toBe(10);
  });

  test("clamps to 0 when penalties exceed base", () => {
    const score = scoreEvent(
      makeEvent({ role: "system", type: "hook_startup", content: "x".repeat(2001) }),
      { baseScore: 20 },
    );
    // 20 + (-5) + (-20) + (-15) = -20 → clamped to 0
    expect(score).toBe(0);
  });

  test("clamps to 100 when bonuses are excessive", () => {
    const score = scoreEvent(
      makeEvent({
        role: "user",
        type: "user",
        toolName: "Write",
        isError: true,
        content: "```ts\n// code\n```",
      }),
      { baseScore: 80 },
    );
    // 80 + 15 + 20 + 10 + 10 + 12 = 147 → clamped to 100
    expect(score).toBe(100);
  });

  test("accepts custom config overrides", () => {
    const score = scoreEvent(makeEvent(), { baseScore: 75 });
    expect(score).toBe(75);
  });

  test("custom config merges with defaults", () => {
    const score = scoreEvent(
      makeEvent({ toolName: "Bash" }),
      { toolUseBonus: 30 },
    );
    // default base(50) + custom toolUse(30) = 80
    expect(score).toBe(80);
  });
});
