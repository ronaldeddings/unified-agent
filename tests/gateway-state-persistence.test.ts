import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GatewayRouter } from "../src/gateway/router";
import { GatewayStateStore } from "../src/gateway/stateStore";

describe("gateway state persistence", () => {
  test("restores queue and pending permissions across router restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "unified-agent-gw-state-"));
    const statePath = join(dir, "gateway-state.json");

    const router1 = new GatewayRouter({ stateStore: new GatewayStateStore(statePath) });
    const sessionId = "persist_s1";

    await router1.handleEnvelope(sessionId, {
      type: "control_request",
      request_id: "req_init",
      request: { subtype: "initialize", provider: "mock" },
    });

    router1.enqueueOutbound(sessionId, "out_1", {
      type: "system",
      subtype: "status",
      session_id: sessionId,
      payload: { queued: true },
    });

    const state = router1.registry.get(sessionId)!;
    state.pendingPermissions.add("req_pending", sessionId, {
      subtype: "can_use_tool",
      tool_name: "Bash",
      input: { command: "ls" },
      tool_use_id: "tool_1",
    });
    // Trigger persistence after direct mutation.
    router1.enqueueOutbound(sessionId, "out_2", {
      type: "keep_alive",
    });

    const router2 = new GatewayRouter({ stateStore: new GatewayStateStore(statePath) });
    const restored = router2.registry.get(sessionId);
    expect(restored).toBeDefined();
    expect(restored?.outbound.size()).toBe(2);
    expect(restored?.pendingPermissions.has("req_pending")).toBe(true);

    const flushed: string[] = [];
    await router2.flushOutbound(sessionId, (event) => {
      flushed.push((event as any).type);
    });
    expect(flushed.length).toBe(2);

    const router3 = new GatewayRouter({ stateStore: new GatewayStateStore(statePath) });
    expect(router3.registry.get(sessionId)?.outbound.size()).toBe(0);
  });
});
