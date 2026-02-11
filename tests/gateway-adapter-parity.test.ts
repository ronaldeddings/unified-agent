import { describe, expect, test } from "bun:test";
import { CodexCompatAdapter } from "../src/adapters/codexCompat";
import { GeminiCompatAdapter } from "../src/adapters/geminiCompat";

const ctxBase = {
  metaSessionId: "ms_test",
  gatewaySessionId: "gw_test",
  project: "p",
  cwd: process.cwd(),
  model: undefined,
  permissionMode: "bypassPermissions" as const,
};

describe("adapter compatibility parity", () => {
  test("codex supports full control subtype matrix via emulation", async () => {
    const a = new CodexCompatAdapter();
    const ctx = { ...ctxBase, provider: "codex" as const };
    expect(a.capabilities.supportedControlSubtypes.has("mcp_status")).toBe(true);
    expect((await a.mcpStatus?.(ctx) as any).provider).toBe("codex");
    expect((await a.mcpMessage?.(ctx, "s", { ok: true }) as any).accepted).toBe(true);
    expect((await a.mcpSetServers?.(ctx, { a: {} }) as any).configured).toEqual(["a"]);
    expect((await a.mcpReconnect?.(ctx, "a") as any).reconnected).toBe(true);
    expect((await a.mcpToggle?.(ctx, "a", true) as any).enabled).toBe(true);
    expect((await a.rewindFiles?.(ctx, "u1", true) as any).dryRun).toBe(true);
    expect((await a.hookCallback?.(ctx, "cb1", { x: 1 }) as any).accepted).toBe(true);
  });

  test("gemini supports full control subtype matrix via emulation", async () => {
    const a = new GeminiCompatAdapter();
    const ctx = { ...ctxBase, provider: "gemini" as const };
    expect(a.capabilities.supportedControlSubtypes.has("mcp_status")).toBe(true);
    expect((await a.mcpStatus?.(ctx) as any).provider).toBe("gemini");
    expect((await a.mcpMessage?.(ctx, "s", { ok: true }) as any).accepted).toBe(true);
    expect((await a.mcpSetServers?.(ctx, { a: {} }) as any).configured).toEqual(["a"]);
    expect((await a.mcpReconnect?.(ctx, "a") as any).reconnected).toBe(true);
    expect((await a.mcpToggle?.(ctx, "a", true) as any).enabled).toBe(true);
    expect((await a.rewindFiles?.(ctx, "u1", true) as any).dryRun).toBe(true);
    expect((await a.hookCallback?.(ctx, "cb1", { x: 1 }) as any).accepted).toBe(true);
  });
});
