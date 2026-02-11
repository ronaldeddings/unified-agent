import { describe, expect, test } from "bun:test";
import { OutboundQueue } from "../src/gateway/outboundQueue";
import { PendingPermissions } from "../src/gateway/pendingPermissions";

describe("gateway queue and permissions", () => {
  test("outbound queue dedupes and flushes in order", async () => {
    const q = new OutboundQueue();
    q.enqueue("1", { type: "keep_alive" });
    q.enqueue("1", { type: "keep_alive" });
    q.enqueue("2", { type: "keep_alive" });
    const sent: string[] = [];
    await q.flush((e) => {
      sent.push((e as any).type);
    });
    expect(sent.length).toBe(2);
    expect(q.size()).toBe(0);
  });

  test("pending permission cancellation emits events", () => {
    const p = new PendingPermissions();
    p.add("req_1", "s1", {
      subtype: "can_use_tool",
      tool_name: "Bash",
      input: {},
      tool_use_id: "tool_1",
    });
    const cancelled = p.cancelBySession("s1", "disconnect");
    expect(cancelled.length).toBe(1);
    expect(cancelled[0].type).toBe("permission_cancelled");
  });
});
