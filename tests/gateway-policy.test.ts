import { describe, expect, test } from "bun:test";
import { GatewayRateLimiter, validateBrainUrl, validateCanUseToolDecision } from "../src/gateway/policy";

describe("gateway policy", () => {
  test("validateBrainUrl allows wss by default", () => {
    expect(() => validateBrainUrl("wss://brain.example/ws", {})).not.toThrow();
  });

  test("validateBrainUrl denies ws by default", () => {
    expect(() => validateBrainUrl("ws://brain.example/ws", {})).toThrow();
  });

  test("validateCanUseToolDecision enforces behavior", () => {
    const ok = validateCanUseToolDecision({ behavior: "allow", updatedInput: { cmd: "ls" } });
    expect(ok.behavior).toBe("allow");
    expect(() => validateCanUseToolDecision({ behavior: "maybe" })).toThrow();
  });

  test("rate limiter blocks over budget", () => {
    const limiter = new GatewayRateLimiter(2);
    expect(limiter.accept("s1", 1)).toBe(true);
    expect(limiter.accept("s1", 2)).toBe(true);
    expect(limiter.accept("s1", 3)).toBe(false);
  });
});
