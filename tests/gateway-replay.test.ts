import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEventJsonl } from "../src/storage/jsonl";
import { replayCanonicalSession } from "../src/gateway/replayRunner";

describe("gateway replay runner", () => {
  test("builds replay report from canonical jsonl", async () => {
    const dir = await mkdtemp(join(tmpdir(), "unified-agent-replay-"));
    process.env.UNIFIED_AGENT_DATA_DIR = dir;

    const sessionId = "ms_replay";
    await appendEventJsonl(sessionId, {
      v: 1,
      ts: new Date(1).toISOString(),
      metaSessionId: sessionId,
      project: "p",
      cwd: "/tmp",
      provider: "mock",
      type: "control_request",
      text: "initialize",
      payload: { subtype: "initialize" },
    });
    await appendEventJsonl(sessionId, {
      v: 1,
      ts: new Date(2).toISOString(),
      metaSessionId: sessionId,
      project: "p",
      cwd: "/tmp",
      provider: "mock",
      type: "control_response",
      text: "success",
      payload: { subtype: "success" },
    });

    const report = await replayCanonicalSession(sessionId);
    expect(report.totalEvents).toBe(2);
    expect(report.byType.control_request).toBe(1);
    expect(report.byType.control_response).toBe(1);
    expect(report.deterministicOrder).toBe(true);
  });
});
