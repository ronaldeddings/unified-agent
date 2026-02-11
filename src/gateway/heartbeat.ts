import type { SessionRegistry } from "./sessionRegistry";

export interface HeartbeatOptions {
  intervalMs?: number;
  staleMs?: number;
  onStale: (sessionId: string) => void;
}

export class HeartbeatMonitor {
  private readonly intervalMs: number;
  private readonly staleMs: number;
  private readonly onStale: (sessionId: string) => void;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly registry: SessionRegistry,
    options: HeartbeatOptions
  ) {
    this.intervalMs = options.intervalMs ?? 10_000;
    this.staleMs = options.staleMs ?? 45_000;
    this.onStale = options.onStale;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      const now = Date.now();
      for (const session of this.registry.list()) {
        if (!session.connected) continue;
        if (now - session.lastSeenEpoch > this.staleMs) {
          this.onStale(session.sessionId);
        }
      }
    }, this.intervalMs);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}
