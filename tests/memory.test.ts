import { describe, expect, test } from "bun:test";
import { ClaudeMemClient } from "../src/memory/claudeMemClient";

describe("ClaudeMemClient", () => {
  test("health false when fetch throws", async () => {
    const c = new ClaudeMemClient("http://127.0.0.1:37777", async () => {
      throw new Error("down");
    });
    expect(await c.health()).toBe(false);
  });

  test("stats returns parsed json on 200", async () => {
    const c = new ClaudeMemClient("http://x", async (url) => {
      if (String(url).endsWith("/api/stats")) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response("no", { status: 404 });
    });
    expect(await c.stats()).toEqual({ ok: true });
  });
});

