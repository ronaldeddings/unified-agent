import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionDb } from "../src/storage/sqlite";
import { appendEventJsonl, getJsonlPath } from "../src/storage/jsonl";
import type { CanonicalEvent } from "../src/session/types";

describe("storage", () => {
  test("sqlite persists meta session and events", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pai-ut-test-"));
    const dbPath = join(dir, "db.sqlite");
    const db = new SessionDb(dbPath);

    db.createMetaSession({
      id: "ms_test",
      project: "p",
      cwd: "/tmp",
      createdAtEpoch: 1,
      activeProvider: "mock",
      activeModel: "gpt-5",
    });

    const e: CanonicalEvent = {
      v: 1,
      ts: new Date(1).toISOString(),
      metaSessionId: "ms_test",
      project: "p",
      cwd: "/tmp",
      provider: "mock",
      type: "user_message",
      text: "hi",
    };
    db.insertEvent(e, 1);

    const s = db.getMetaSession("ms_test");
    expect(s?.id).toBe("ms_test");
    expect(s?.activeModel).toBe("gpt-5");
    expect(db.getRecentEvents("ms_test", 1)[0].text).toBe("hi");

    db.close();
  });

  test("jsonl appends one line per event", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pai-ut-test-"));
    process.env.PAI_UT_DATA_DIR = dir;

    const e: CanonicalEvent = {
      v: 1,
      ts: new Date(1).toISOString(),
      metaSessionId: "ms_test",
      project: "p",
      cwd: "/tmp",
      provider: "mock",
      type: "assistant_message",
      text: "ok",
    };
    await appendEventJsonl("ms_test", e);

    const path = getJsonlPath("ms_test");
    const content = await readFile(path, "utf-8");
    expect(content.trim().length).toBeGreaterThan(10);
    const lines = content.split("\n").filter(Boolean);
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]) as CanonicalEvent;
    expect(parsed.text).toBe("ok");
  });
});
