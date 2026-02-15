import { describe, expect, test } from "bun:test";
import { wrapSessionManagerWithScoring } from "../src/scoring/realtime.ts";
import type { CanonicalEvent } from "../src/session/types.ts";

/** Minimal mock SessionManager that captures recorded events. */
function createMockSessionManager() {
  const recorded: CanonicalEvent[] = [];

  const manager = {
    recordEvent: async (event: CanonicalEvent): Promise<void> => {
      recorded.push(event);
    },
    getCurrent: () => null,
    close: () => {},
    recorded,
  };

  return manager;
}

function makeCanonicalEvent(overrides: Partial<CanonicalEvent> = {}): CanonicalEvent {
  return {
    v: 1,
    ts: new Date().toISOString(),
    metaSessionId: "ms_test_001",
    project: "test",
    cwd: "/tmp",
    provider: "mock",
    type: "user_message",
    text: "Hello world",
    ...overrides,
  };
}

describe("wrapSessionManagerWithScoring", () => {
  test("attaches importanceScore to user_message events", async () => {
    const mock = createMockSessionManager();
    // Cast to satisfy the function signature — we only need recordEvent
    const wrapped = wrapSessionManagerWithScoring(mock as any);

    const event = makeCanonicalEvent({ type: "user_message", text: "What is this?" });
    await wrapped.recordEvent(event);

    expect(mock.recorded).toHaveLength(1);
    expect(mock.recorded[0].importanceScore).toBeNumber();
    expect(mock.recorded[0].importanceScore).toBeGreaterThan(0);
  });

  test("attaches importanceScore to assistant_message events", async () => {
    const mock = createMockSessionManager();
    const wrapped = wrapSessionManagerWithScoring(mock as any);

    const event = makeCanonicalEvent({ type: "assistant_message", text: "Here is the answer." });
    await wrapped.recordEvent(event);

    expect(mock.recorded[0].importanceScore).toBeNumber();
  });

  test("attaches importanceScore to error events", async () => {
    const mock = createMockSessionManager();
    const wrapped = wrapSessionManagerWithScoring(mock as any);

    const event = makeCanonicalEvent({ type: "error", text: "Something failed" });
    await wrapped.recordEvent(event);

    expect(mock.recorded[0].importanceScore).toBeNumber();
    // Error events should get the error bonus, resulting in higher score
    expect(mock.recorded[0].importanceScore!).toBeGreaterThanOrEqual(50);
  });

  test("user_message gets higher score than system events", async () => {
    const mock = createMockSessionManager();
    const wrapped = wrapSessionManagerWithScoring(mock as any);

    const userEvent = makeCanonicalEvent({ type: "user_message", text: "Question" });
    const systemEvent = makeCanonicalEvent({ type: "meta_session_created", text: "created session" });

    await wrapped.recordEvent(userEvent);
    await wrapped.recordEvent(systemEvent);

    expect(mock.recorded[0].importanceScore!).toBeGreaterThan(mock.recorded[1].importanceScore!);
  });

  test("preserves original event data after scoring", async () => {
    const mock = createMockSessionManager();
    const wrapped = wrapSessionManagerWithScoring(mock as any);

    const event = makeCanonicalEvent({
      type: "user_message",
      text: "Keep this text",
      metaSessionId: "ms_preserve_test",
    });
    await wrapped.recordEvent(event);

    expect(mock.recorded[0].text).toBe("Keep this text");
    expect(mock.recorded[0].metaSessionId).toBe("ms_preserve_test");
    expect(mock.recorded[0].type).toBe("user_message");
  });

  test("accepts custom scoring config", async () => {
    const mock = createMockSessionManager();
    const wrapped = wrapSessionManagerWithScoring(mock as any, { baseScore: 75 });

    const event = makeCanonicalEvent({ type: "assistant_message", text: "response" });
    await wrapped.recordEvent(event);

    // Assistant message with base 75 should score exactly 75 (no bonuses apply)
    expect(mock.recorded[0].importanceScore).toBe(75);
  });

  test("returns the same manager instance", () => {
    const mock = createMockSessionManager();
    const wrapped = wrapSessionManagerWithScoring(mock as any);
    expect(wrapped).toBe(mock);
  });

  test("scores multiple events independently", async () => {
    const mock = createMockSessionManager();
    const wrapped = wrapSessionManagerWithScoring(mock as any);

    await wrapped.recordEvent(makeCanonicalEvent({ type: "user_message", text: "Q1" }));
    await wrapped.recordEvent(makeCanonicalEvent({ type: "assistant_message", text: "A1" }));
    await wrapped.recordEvent(makeCanonicalEvent({ type: "error", text: "E1" }));

    expect(mock.recorded).toHaveLength(3);
    // Each should have a score
    for (const event of mock.recorded) {
      expect(event.importanceScore).toBeNumber();
      expect(event.importanceScore).toBeGreaterThanOrEqual(0);
      expect(event.importanceScore).toBeLessThanOrEqual(100);
    }
  });
});
