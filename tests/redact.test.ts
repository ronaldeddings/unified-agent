import { describe, expect, test } from "bun:test";
import { redactForStorage } from "../src/util/redact";

describe("redactForStorage", () => {
  test("redacts <private> blocks", () => {
    const s = "a <private>secret</private> b";
    expect(redactForStorage(s)).toBe("a <private>[REDACTED]</private> b");
  });

  test("redacts OpenAI-style keys", () => {
    const s = "sk-1234567890abcdefghijklmnop";
    expect(redactForStorage(s)).toBe("sk-[REDACTED]");
  });
});

