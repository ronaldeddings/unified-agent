import type { UcpEnvelope } from "./protocol";

export class ReplayBuffer {
  private readonly maxSize: number;
  private readonly entries: UcpEnvelope[] = [];

  constructor(maxSize = 1000) {
    this.maxSize = Math.max(1, maxSize);
  }

  push(event: UcpEnvelope): void {
    this.entries.push(event);
    if (this.entries.length > this.maxSize) {
      this.entries.splice(0, this.entries.length - this.maxSize);
    }
  }

  getAll(): UcpEnvelope[] {
    return [...this.entries];
  }

  clear(): void {
    this.entries.length = 0;
  }

  static fromArray(events: UcpEnvelope[], maxSize = 1000): ReplayBuffer {
    const b = new ReplayBuffer(maxSize);
    for (const e of events || []) b.push(e);
    return b;
  }
}
