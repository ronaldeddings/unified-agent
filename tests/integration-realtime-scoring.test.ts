/**
 * Integration test: real-time scoring via wrapped SessionManager.
 * Item 87: Send 10 events through wrapped SessionManager, verify all have importanceScore.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionManager } from "../src/session/manager.ts";
import { wrapSessionManagerWithScoring } from "../src/scoring/realtime.ts";

let tmpDir: string;
let originalDataDir: string | undefined;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "distill-realtime-"));
  originalDataDir = process.env.UNIFIED_AGENT_DATA_DIR;
  process.env.UNIFIED_AGENT_DATA_DIR = tmpDir;
});

afterEach(async () => {
  if (originalDataDir !== undefined) {
    process.env.UNIFIED_AGENT_DATA_DIR = originalDataDir;
  } else {
    delete process.env.UNIFIED_AGENT_DATA_DIR;
  }
  await rm(tmpDir, { recursive: true, force: true });
});

describe("Item 87: Real-time scoring integration", () => {
  test("10 events through wrapped SessionManager all have importanceScore", async () => {
    const rawManager = new SessionManager();
    const manager = wrapSessionManagerWithScoring(rawManager);

    // Create a session
    await manager.newSession({
      project: "realtime-test",
      cwd: tmpDir,
      provider: "mock",
    });

    // Send 10 events: 5 user messages + 5 assistant responses
    const messages = [
      { type: "user" as const, text: "How do I set up authentication?" },
      { type: "assistant" as const, text: "You can use JWT tokens for authentication. Here's how:\n```typescript\nimport jwt from 'jsonwebtoken';\n```" },
      { type: "user" as const, text: "What about password hashing?" },
      { type: "assistant" as const, text: "Use bcrypt for password hashing." },
      { type: "user" as const, text: "Show me the middleware code" },
      { type: "assistant" as const, text: "Here's the auth middleware:\n```typescript\nfunction authMiddleware(req, res, next) {\n  const token = req.headers.authorization;\n}\n```" },
      { type: "user" as const, text: "What about rate limiting?" },
      { type: "assistant" as const, text: "Add rate limiting with a token bucket algorithm." },
      { type: "user" as const, text: "How do I test this?" },
      { type: "assistant" as const, text: "Write integration tests using bun:test with mock HTTP requests." },
    ];

    for (const msg of messages) {
      if (msg.type === "user") {
        await manager.recordUser(msg.text);
      } else {
        await manager.recordAssistant(msg.text);
      }
    }

    // Retrieve all events from the session
    const events = manager.getRecentEvents(200);

    // Filter to user_message and assistant_message events (skip meta_session_created)
    const contentEvents = events.filter(
      (e) => e.type === "user_message" || e.type === "assistant_message",
    );

    // Should have exactly 10 content events
    expect(contentEvents.length).toBe(10);

    // Every content event must have importanceScore attached
    for (const event of contentEvents) {
      expect(event.importanceScore).toBeDefined();
      expect(typeof event.importanceScore).toBe("number");
      expect(event.importanceScore!).toBeGreaterThanOrEqual(0);
      expect(event.importanceScore!).toBeLessThanOrEqual(100);
    }

    // Verify user messages get higher base scores (userPromptBonus)
    const userEvents = contentEvents.filter((e) => e.type === "user_message");
    const assistantEvents = contentEvents.filter((e) => e.type === "assistant_message");

    expect(userEvents.length).toBe(5);
    expect(assistantEvents.length).toBe(5);

    // User messages should have base 50 + userPromptBonus 10 = 60 minimum
    for (const event of userEvents) {
      expect(event.importanceScore!).toBeGreaterThanOrEqual(50);
    }

    // Assistant messages with code blocks should score higher than those without
    const withCode = assistantEvents.filter((e) => e.text.includes("```"));
    const withoutCode = assistantEvents.filter((e) => !e.text.includes("```"));

    if (withCode.length > 0 && withoutCode.length > 0) {
      const avgWithCode = withCode.reduce((s, e) => s + e.importanceScore!, 0) / withCode.length;
      const avgWithoutCode = withoutCode.reduce((s, e) => s + e.importanceScore!, 0) / withoutCode.length;
      expect(avgWithCode).toBeGreaterThan(avgWithoutCode);
    }

    manager.close();
  });
});
