import { describe, expect, test } from "bun:test";
import { GatewayRouter } from "../src/gateway/router";

const matrixCalls = [
  { subtype: "mcp_status", request: { subtype: "mcp_status" } },
  { subtype: "mcp_message", request: { subtype: "mcp_message", server_name: "srv", message: { ping: true } } },
  { subtype: "mcp_set_servers", request: { subtype: "mcp_set_servers", servers: { srv: {} } } },
  { subtype: "mcp_reconnect", request: { subtype: "mcp_reconnect", serverName: "srv" } },
  { subtype: "mcp_toggle", request: { subtype: "mcp_toggle", serverName: "srv", enabled: true } },
  { subtype: "rewind_files", request: { subtype: "rewind_files", user_message_id: "u1", dry_run: true } },
  { subtype: "hook_callback", request: { subtype: "hook_callback", callback_id: "cb1", input: { ok: true } } },
] as const;

describe("gateway router control matrix", () => {
  test("codex matrix subtypes return success", async () => {
    const router = new GatewayRouter();
    const sessionId = "matrix_codex";

    await router.handleEnvelope(sessionId, {
      type: "control_request",
      request_id: "req_init",
      request: { subtype: "initialize", provider: "codex" },
    });

    for (const [i, entry] of matrixCalls.entries()) {
      const out = await router.handleEnvelope(sessionId, {
        type: "control_request",
        request_id: `req_${entry.subtype}_${i}`,
        request: entry.request as any,
      });
      const resp = out.find((e) => e.type === "control_response") as any;
      expect(resp).toBeDefined();
      expect(resp.response.subtype).toBe("success");
    }
  });

  test("gemini matrix subtypes return success", async () => {
    const router = new GatewayRouter();
    const sessionId = "matrix_gemini";

    await router.handleEnvelope(sessionId, {
      type: "control_request",
      request_id: "req_init",
      request: { subtype: "initialize", provider: "gemini" },
    });

    for (const [i, entry] of matrixCalls.entries()) {
      const out = await router.handleEnvelope(sessionId, {
        type: "control_request",
        request_id: `req_${entry.subtype}_${i}`,
        request: entry.request as any,
      });
      const resp = out.find((e) => e.type === "control_response") as any;
      expect(resp).toBeDefined();
      expect(resp.response.subtype).toBe("success");
    }
  });
});
