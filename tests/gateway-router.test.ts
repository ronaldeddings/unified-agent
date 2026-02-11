import { describe, expect, test } from "bun:test";
import { GatewayRouter } from "../src/gateway/router";

describe("gateway router", () => {
  test("initialize -> user -> assistant lifecycle", async () => {
    const router = new GatewayRouter();
    const sessionId = "s1";

    const init = await router.handleEnvelope(sessionId, {
      type: "control_request",
      request_id: "req_init",
      request: { subtype: "initialize", provider: "mock" },
    });
    expect(init.some((e) => e.type === "control_response")).toBe(true);

    const user = await router.handleEnvelope(sessionId, {
      type: "user",
      session_id: sessionId,
      message: { role: "user", content: "hello" },
    });

    const assistant = user.find((e) => e.type === "assistant") as any;
    expect(assistant).toBeDefined();
    expect(assistant.event.text).toContain("mock:");
  });

  test("set_model updates state and returns success", async () => {
    const router = new GatewayRouter();
    const sessionId = "s2";

    await router.handleEnvelope(sessionId, {
      type: "control_request",
      request_id: "req_init",
      request: { subtype: "initialize", provider: "mock" },
    });

    const out = await router.handleEnvelope(sessionId, {
      type: "control_request",
      request_id: "req_model",
      request: { subtype: "set_model", model: "gpt-5" },
    });

    const response = out.find((e) => e.type === "control_response") as any;
    expect(response).toBeDefined();
    expect(response.response.subtype).toBe("success");
  });

  test("cancel request returns cancellation response", async () => {
    const router = new GatewayRouter();
    const sessionId = "s3";

    await router.handleEnvelope(sessionId, {
      type: "control_request",
      request_id: "req_init",
      request: { subtype: "initialize", provider: "mock" },
    });

    await router.handleEnvelope(sessionId, {
      type: "control_request",
      request_id: "req_perm",
      request: {
        subtype: "can_use_tool",
        tool_name: "Bash",
        input: { command: "ls" },
        tool_use_id: "tool_1",
      },
    });

    const cancelled = await router.handleEnvelope(sessionId, {
      type: "control_cancel_request",
      request_id: "req_perm",
    });

    expect(cancelled.some((e) => e.type === "control_response")).toBe(true);
  });
});
