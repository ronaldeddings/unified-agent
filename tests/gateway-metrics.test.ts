import { describe, expect, test } from "bun:test";
import { GatewayMetrics } from "../src/gateway/metrics";

describe("gateway metrics", () => {
  test("records counters and latency", () => {
    const m = new GatewayMetrics();
    m.requestsTotal("claude", "initialize");
    m.requestsTotal("claude", "initialize");
    m.observeLatency("control_response_latency_ms", 10, { provider: "claude", subtype: "initialize" });
    m.observeLatency("control_response_latency_ms", 20, { provider: "claude", subtype: "initialize" });

    const snap = m.snapshot();
    const counterEntry = Object.entries(snap.counters).find(([k]) => k.includes("requests_total") && k.includes("provider=claude"));
    expect(counterEntry?.[1]).toBe(2);
    const latencyEntry = Object.entries(snap.latency).find(([k]) => k.includes("control_response_latency_ms"));
    expect(latencyEntry?.[1].count).toBe(2);
  });
});
