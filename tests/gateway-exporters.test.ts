import { describe, expect, test } from "bun:test";
import { GatewayMetrics } from "../src/gateway/metrics";
import { buildOtlpPayload } from "../src/gateway/otlp";

describe("gateway metric exporters", () => {
  test("prometheus output contains counter and latency metrics", () => {
    const m = new GatewayMetrics();
    m.requestsTotal("claude", "initialize");
    m.observeLatency("control_response_latency_ms", 10, { provider: "claude", subtype: "initialize" });

    const out = m.toPrometheus();
    expect(out).toContain("unified_agent_gateway_requests_total");
    expect(out).toContain("unified_agent_gateway_latency_ms");
    expect(out).toContain('provider="claude"');
  });

  test("otlp payload builder includes counters and gauges", () => {
    const m = new GatewayMetrics();
    m.requestsTotal("codex", "set_model");
    m.observeLatency("control_response_latency_ms", 25, { provider: "codex", subtype: "set_model" });

    const payload = buildOtlpPayload(m.snapshot());
    expect(payload.metrics.some((x) => x.name === "requests_total")).toBe(true);
    expect(payload.metrics.some((x) => x.name.includes("control_response_latency_ms"))).toBe(true);
  });
});
