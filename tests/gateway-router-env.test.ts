import { describe, expect, test } from "bun:test";
import { GatewayRouter } from "../src/gateway/router";

describe("gateway router env application", () => {
  test("applyEnvironmentVariables updates session env", async () => {
    const router = new GatewayRouter();
    const sessionId = "env_s1";

    await router.handleEnvelope(sessionId, {
      type: "control_request",
      request_id: "req_init",
      request: { subtype: "initialize", provider: "mock" },
    });

    const applied = router.applyEnvironmentVariables(sessionId, { HELLO: "world" });
    expect(applied).toBe(1);
    expect(router.registry.get(sessionId)?.envVars?.HELLO).toBe("world");
  });
});
