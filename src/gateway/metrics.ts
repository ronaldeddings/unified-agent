import type { ProviderName } from "../session/types";

function key(parts: Array<string | undefined>): string {
  return parts.map((p) => p || "_").join("|");
}

function splitKey(k: string): { name: string; labels: Record<string, string> } {
  const [name, ...rest] = k.split("|");
  const labels: Record<string, string> = {};
  for (const part of rest) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const lk = part.slice(0, idx);
    const lv = part.slice(idx + 1);
    labels[lk] = lv;
  }
  return { name, labels };
}

export class GatewayMetrics {
  private readonly counters = new Map<string, number>();
  private readonly latency = new Map<string, number[]>();

  incCounter(name: string, labels: Record<string, string | undefined> = {}): void {
    const k = key([name, ...Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)).map(([k2, v2]) => `${k2}=${v2 || ""}`)]);
    this.counters.set(k, (this.counters.get(k) || 0) + 1);
  }

  observeLatency(name: string, ms: number, labels: Record<string, string | undefined> = {}): void {
    const k = key([name, ...Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)).map(([k2, v2]) => `${k2}=${v2 || ""}`)]);
    const bucket = this.latency.get(k) || [];
    bucket.push(ms);
    this.latency.set(k, bucket);
  }

  snapshot(): {
    counters: Record<string, number>;
    latency: Record<string, { count: number; avgMs: number; p95Ms: number }>;
  } {
    const counters: Record<string, number> = {};
    const latency: Record<string, { count: number; avgMs: number; p95Ms: number }> = {};

    for (const [k, v] of this.counters.entries()) counters[k] = v;

    for (const [k, values] of this.latency.entries()) {
      const sorted = [...values].sort((a, b) => a - b);
      const avg = sorted.reduce((sum, n) => sum + n, 0) / Math.max(1, sorted.length);
      const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95) - 1));
      latency[k] = {
        count: sorted.length,
        avgMs: Number(avg.toFixed(2)),
        p95Ms: sorted[idx] || 0,
      };
    }

    return { counters, latency };
  }

  // Convenience wrappers used by router.
  requestsTotal(provider: ProviderName, subtype: string): void {
    this.incCounter("requests_total", { provider, subtype });
  }

  reconnectAttempts(provider: ProviderName): void {
    this.incCounter("reconnect_attempts_total", { provider });
  }

  policyDenials(provider: ProviderName, reason: string): void {
    this.incCounter("policy_denials_total", { provider, reason });
  }

  unsupportedSubtype(provider: ProviderName, subtype: string): void {
    this.incCounter("unsupported_subtype_total", { provider, subtype });
  }

  // Distillation counters
  distillScans(): void {
    this.incCounter("distill_scans_total");
  }

  distillRuns(): void {
    this.incCounter("distill_runs_total");
  }

  distillChunksAssessed(count: number = 1): void {
    for (let i = 0; i < count; i++) {
      this.incCounter("distill_chunks_assessed");
    }
  }

  distillSessionsGenerated(platform: string): void {
    this.incCounter("distill_sessions_generated", { platform });
  }

  toPrometheus(): string {
    const lines: string[] = [];
    lines.push("# HELP unified_agent_gateway_counter Generic gateway counters");
    lines.push("# TYPE unified_agent_gateway_counter counter");
    for (const [k, v] of this.counters.entries()) {
      const parsed = splitKey(k);
      const labelParts = Object.entries(parsed.labels)
        .map(([lk, lv]) => `${lk}=\"${escapeProm(lv)}\"`)
        .join(",");
      const metricName = `unified_agent_gateway_${sanitizeMetricName(parsed.name)}`;
      lines.push(`${metricName}{${labelParts}} ${v}`);
    }

    lines.push("# HELP unified_agent_gateway_latency_ms Gateway latency summaries");
    lines.push("# TYPE unified_agent_gateway_latency_ms gauge");
    for (const [k, values] of this.latency.entries()) {
      const parsed = splitKey(k);
      const sorted = [...values].sort((a, b) => a - b);
      const avg = sorted.reduce((sum, n) => sum + n, 0) / Math.max(1, sorted.length);
      const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95) - 1));
      const p95 = sorted[idx] || 0;
      const labels = { ...parsed.labels, metric: parsed.name };
      const labelParts = Object.entries(labels)
        .map(([lk, lv]) => `${lk}=\"${escapeProm(lv)}\"`)
        .join(",");
      lines.push(`unified_agent_gateway_latency_ms{${labelParts},stat=\"avg\"} ${Number(avg.toFixed(2))}`);
      lines.push(`unified_agent_gateway_latency_ms{${labelParts},stat=\"p95\"} ${p95}`);
      lines.push(`unified_agent_gateway_latency_ms{${labelParts},stat=\"count\"} ${sorted.length}`);
    }
    return `${lines.join("\n")}\n`;
  }
}

function sanitizeMetricName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, "_");
}

function escapeProm(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}
