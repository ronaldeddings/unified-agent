import type { UcpEnvelope } from "./protocol";

export interface QueuedEnvelope {
  id: string;
  value: UcpEnvelope;
}

export class OutboundQueue {
  private readonly items: QueuedEnvelope[] = [];
  private readonly seen = new Set<string>();

  enqueue(id: string, value: UcpEnvelope): void {
    if (this.seen.has(id)) return;
    this.seen.add(id);
    this.items.push({ id, value });
  }

  size(): number {
    return this.items.length;
  }

  clear(): void {
    this.items.length = 0;
    this.seen.clear();
  }

  async flush(send: (event: UcpEnvelope) => Promise<void> | void): Promise<void> {
    while (this.items.length > 0) {
      const next = this.items.shift()!;
      await send(next.value);
      this.seen.delete(next.id);
    }
  }

  toArray(): QueuedEnvelope[] {
    return [...this.items];
  }

  static fromArray(items: QueuedEnvelope[]): OutboundQueue {
    const q = new OutboundQueue();
    for (const item of items || []) {
      if (!item || typeof item.id !== "string") continue;
      q.enqueue(item.id, item.value);
    }
    return q;
  }
}
