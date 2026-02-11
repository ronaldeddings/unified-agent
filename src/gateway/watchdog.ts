import type { SessionRegistry } from "./sessionRegistry";

export interface WatchdogOptions {
  graceMs?: number;
  onRelaunch: (sessionId: string) => Promise<void> | void;
}

export class RelaunchWatchdog {
  private readonly graceMs: number;
  private readonly onRelaunch: (sessionId: string) => Promise<void> | void;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly registry: SessionRegistry,
    options: WatchdogOptions
  ) {
    this.graceMs = options.graceMs ?? 20_000;
    this.onRelaunch = options.onRelaunch;
  }

  schedule(sessionId: string): void {
    this.clear(sessionId);
    const timer = setTimeout(async () => {
      const state = this.registry.get(sessionId);
      if (!state || state.connected) return;
      await this.onRelaunch(sessionId);
    }, this.graceMs);
    this.timers.set(sessionId, timer);
  }

  clear(sessionId: string): void {
    const timer = this.timers.get(sessionId);
    if (!timer) return;
    clearTimeout(timer);
    this.timers.delete(sessionId);
  }

  clearAll(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }
}
