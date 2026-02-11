import { describe, expect, test } from "bun:test";
import { parseEnvelope, successResponse, errorResponse } from "../src/gateway/protocol";

describe("gateway protocol", () => {
  test("parses initialize control request", () => {
    const parsed = parseEnvelope({
      type: "control_request",
      request_id: "req_1",
      request: {
        subtype: "initialize",
        provider: "claude",
      },
    });
    expect(parsed.ok).toBe(true);
  });

  test("rejects unknown control subtype", () => {
    const parsed = parseEnvelope({
      type: "control_request",
      request_id: "req_1",
      request: {
        subtype: "do_magic",
      },
    });
    expect(parsed.ok).toBe(false);
  });

  test("builds success response", () => {
    const out = successResponse("req_1", { ok: true });
    expect(out.type).toBe("control_response");
    expect(out.response.subtype).toBe("success");
  });

  test("builds error response", () => {
    const out = errorResponse("req_1", "bad", "INVALID_ARGUMENT");
    expect(out.type).toBe("control_response");
    expect(out.response.subtype).toBe("error");
  });
});
