import { describe, expect, test } from "bun:test";
import { parseArgs } from "../src/cli";

describe("cli parseArgs", () => {
  test("parses brain flags", () => {
    const args = parseArgs([
      "--brain-url",
      "wss://brain.example/ws",
      "--brain-provider",
      "claude",
      "--brain-session-id",
      "gw_123",
      "--once",
      "hello",
    ]);
    expect(args.brainUrl).toBe("wss://brain.example/ws");
    expect(args.brainProvider).toBe("claude");
    expect(args.brainSessionId).toBe("gw_123");
    expect(args.once).toBe(true);
    expect(args.prompt).toBe("hello");
  });

  test("rejects invalid brain url protocol", () => {
    expect(() => parseArgs(["--brain-url", "https://brain.example/ws"]))
      .toThrow("--brain-url must use ws:// or wss://");
  });

  test("rejects invalid brain provider", () => {
    expect(() => parseArgs(["--brain-provider", "openai" as any]))
      .toThrow("invalid --brain-provider");
  });
});
