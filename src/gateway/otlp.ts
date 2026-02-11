import type { GatewayMetrics } from "./metrics";

export interface OtlpExporterOptions {
  endpoint: string;
  intervalMs?: number;
  headers?: Record<string, string>;
}

export interface OtlpMetricPoint {
  name: string;
  labels: Record<string, string>;
  value: number;
  type: "counter" | "gauge";
}

export interface OtlpPayload {
  timestampUnixNano: string;
  metrics: OtlpMetricPoint[];
}

export function buildOtlpPayload(snapshot: ReturnType<GatewayMetrics["snapshot"]>): OtlpPayload {
  const metrics: OtlpMetricPoint[] = [];
  for (const [k, v] of Object.entries(snapshot.counters)) {
    const parsed = splitKey(k);
    metrics.push({ name: parsed.name, labels: parsed.labels, value: v, type: "counter" });
  }
  for (const [k, v] of Object.entries(snapshot.latency)) {
    const parsed = splitKey(k);
    metrics.push({ name: `${parsed.name}.avg_ms`, labels: parsed.labels, value: v.avgMs, type: "gauge" });
    metrics.push({ name: `${parsed.name}.p95_ms`, labels: parsed.labels, value: v.p95Ms, type: "gauge" });
    metrics.push({ name: `${parsed.name}.count`, labels: parsed.labels, value: v.count, type: "gauge" });
  }
  return {
    timestampUnixNano: `${Date.now()}000000`,
    metrics,
  };
}

export class OtlpMetricsExporter {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly metrics: GatewayMetrics,
    private readonly options: OtlpExporterOptions
  ) {}

  start(): void {
    if (this.timer) return;
    const interval = this.options.intervalMs || 15_000;
    this.timer = setInterval(() => {
      void this.flush();
    }, interval);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  async flush(): Promise<void> {
    const snapshot = this.metrics.snapshot();
    const payload = buildOtlpPayload(snapshot);
    await fetch(this.options.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.options.headers || {}),
      },
      body: JSON.stringify(payload),
    });
  }
}

function splitKey(k: string): { name: string; labels: Record<string, string> } {
  const [name, ...rest] = k.split("|");
  const labels: Record<string, string> = {};
  for (const part of rest) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    labels[part.slice(0, idx)] = part.slice(idx + 1);
  }
  return { name, labels };
}
