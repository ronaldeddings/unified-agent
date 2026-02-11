import { describe, expect, test } from "bun:test";
import {
  normalizeClaudeEvent,
  normalizeCodexEvent,
  normalizeGeminiEvent,
  normalizeEnvironmentUpdate,
} from "../src/gateway/normalizers";

describe("gateway normalizers", () => {
  test("normalizes claude init to auth_status", () => {
    const out = normalizeClaudeEvent({ type: "system", subtype: "init", model: "claude-sonnet-4" });
    expect(out.some((x) => x.type === "auth_status")).toBe(true);
  });

  test("normalizes codex events", () => {
    const out = normalizeCodexEvent({ type: "thread.started", thread_id: "t1" });
    expect(out.some((x) => x.type === "auth_status")).toBe(true);
  });

  test("normalizes gemini tool events", () => {
    const out = normalizeGeminiEvent({ type: "tool_call", name: "Bash" });
    expect(out.some((x) => x.type === "tool_progress")).toBe(true);
  });

  test("normalizes environment updates", () => {
    const out = normalizeEnvironmentUpdate({ A: "1", B: "2" });
    expect(out.type).toBe("update_environment_variables");
    expect(out.payload.count).toBe(2);
  });
});
