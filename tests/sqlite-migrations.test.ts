import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { SessionDb } from "../src/storage/sqlite";

describe("sqlite migrations", () => {
  test("adds remote metadata columns for legacy schema", async () => {
    const dir = await mkdtemp(join(tmpdir(), "unified-agent-migration-"));
    const dbPath = join(dir, "sessions.db");

    const legacy = new Database(dbPath);
    legacy.run(`
      CREATE TABLE meta_sessions (
        id TEXT PRIMARY KEY,
        project TEXT NOT NULL,
        cwd TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL,
        active_provider TEXT NOT NULL
      );
    `);
    legacy.run(`
      CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        meta_session_id TEXT NOT NULL,
        ts TEXT NOT NULL,
        provider TEXT NOT NULL,
        type TEXT NOT NULL,
        text TEXT NOT NULL,
        project TEXT NOT NULL,
        cwd TEXT NOT NULL,
        raw_json TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL
      );
    `);
    legacy.close();

    const db = new SessionDb(dbPath);
    db.close();

    const verify = new Database(dbPath);
    const metaCols = verify.query("PRAGMA table_info(meta_sessions)").all() as Array<{ name: string }>;
    const eventCols = verify.query("PRAGMA table_info(events)").all() as Array<{ name: string }>;
    verify.close();

    const metaNames = new Set(metaCols.map((c) => c.name));
    const eventNames = new Set(eventCols.map((c) => c.name));

    expect(metaNames.has("brain_url")).toBe(true);
    expect(metaNames.has("brain_provider")).toBe(true);
    expect(metaNames.has("gateway_session_id")).toBe(true);
    expect(metaNames.has("provider_session_id")).toBe(true);
    expect(eventNames.has("payload_json")).toBe(true);
  });
});
