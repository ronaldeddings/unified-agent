import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionDb } from "../src/storage/sqlite";

describe("distill migrations", () => {
  test("creates all 5 distillation tables", async () => {
    const dir = await mkdtemp(join(tmpdir(), "unified-agent-distill-test-"));
    const dbPath = join(dir, "db.sqlite");
    const db = new SessionDb(dbPath);

    // Query sqlite_master for all tables created by distill migrations
    const rawDb = (db as any).db as import("bun:sqlite").Database;
    const tables = rawDb
      .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const tableNames = tables.map((t) => t.name);

    expect(tableNames).toContain("chunks");
    expect(tableNames).toContain("assessments");
    expect(tableNames).toContain("external_sessions");
    expect(tableNames).toContain("_sync_queue");

    // FTS virtual tables show up differently in sqlite_master
    const allEntries = rawDb
      .query("SELECT name, type FROM sqlite_master WHERE name LIKE 'chunk_fts%' ORDER BY name")
      .all() as Array<{ name: string; type: string }>;
    const ftsTables = allEntries.map((e) => e.name);
    expect(ftsTables).toContain("chunk_fts");

    db.close();
  });

  test("adds distillation columns to events table", async () => {
    const dir = await mkdtemp(join(tmpdir(), "unified-agent-distill-test-"));
    const dbPath = join(dir, "db.sqlite");
    const db = new SessionDb(dbPath);

    const rawDb = (db as any).db as import("bun:sqlite").Database;
    const columns = rawDb
      .query("PRAGMA table_info(events)")
      .all() as Array<{ name: string }>;
    const columnNames = columns.map((c) => c.name);

    expect(columnNames).toContain("importance_score");
    expect(columnNames).toContain("chunk_id");
    expect(columnNames).toContain("consensus_score");

    db.close();
  });

  test("chunks table has correct schema", async () => {
    const dir = await mkdtemp(join(tmpdir(), "unified-agent-distill-test-"));
    const dbPath = join(dir, "db.sqlite");
    const db = new SessionDb(dbPath);

    const rawDb = (db as any).db as import("bun:sqlite").Database;
    const columns = rawDb
      .query("PRAGMA table_info(chunks)")
      .all() as Array<{ name: string; type: string }>;
    const columnNames = columns.map((c) => c.name);

    expect(columnNames).toContain("id");
    expect(columnNames).toContain("meta_session_id");
    expect(columnNames).toContain("chunk_index");
    expect(columnNames).toContain("start_event_index");
    expect(columnNames).toContain("end_event_index");
    expect(columnNames).toContain("importance_avg");
    expect(columnNames).toContain("consensus_score");
    expect(columnNames).toContain("token_count");
    expect(columnNames).toContain("summary");
    expect(columnNames).toContain("created_at");

    db.close();
  });

  test("assessments table has correct schema", async () => {
    const dir = await mkdtemp(join(tmpdir(), "unified-agent-distill-test-"));
    const dbPath = join(dir, "db.sqlite");
    const db = new SessionDb(dbPath);

    const rawDb = (db as any).db as import("bun:sqlite").Database;
    const columns = rawDb
      .query("PRAGMA table_info(assessments)")
      .all() as Array<{ name: string }>;
    const columnNames = columns.map((c) => c.name);

    expect(columnNames).toContain("id");
    expect(columnNames).toContain("chunk_id");
    expect(columnNames).toContain("provider");
    expect(columnNames).toContain("score");
    expect(columnNames).toContain("rationale");
    expect(columnNames).toContain("model");
    expect(columnNames).toContain("tokens_used");
    expect(columnNames).toContain("latency_ms");
    expect(columnNames).toContain("created_at");

    db.close();
  });

  test("_sync_queue table has correct schema", async () => {
    const dir = await mkdtemp(join(tmpdir(), "unified-agent-distill-test-"));
    const dbPath = join(dir, "db.sqlite");
    const db = new SessionDb(dbPath);

    const rawDb = (db as any).db as import("bun:sqlite").Database;
    const columns = rawDb
      .query("PRAGMA table_info(_sync_queue)")
      .all() as Array<{ name: string }>;
    const columnNames = columns.map((c) => c.name);

    expect(columnNames).toContain("id");
    expect(columnNames).toContain("operation");
    expect(columnNames).toContain("payload");
    expect(columnNames).toContain("created_at");
    expect(columnNames).toContain("synced_at");

    db.close();
  });

  test("external_sessions table has correct schema", async () => {
    const dir = await mkdtemp(join(tmpdir(), "unified-agent-distill-test-"));
    const dbPath = join(dir, "db.sqlite");
    const db = new SessionDb(dbPath);

    const rawDb = (db as any).db as import("bun:sqlite").Database;
    const columns = rawDb
      .query("PRAGMA table_info(external_sessions)")
      .all() as Array<{ name: string }>;
    const columnNames = columns.map((c) => c.name);

    expect(columnNames).toContain("id");
    expect(columnNames).toContain("platform");
    expect(columnNames).toContain("original_path");
    expect(columnNames).toContain("original_session_id");
    expect(columnNames).toContain("event_count");
    expect(columnNames).toContain("imported_at");
    expect(columnNames).toContain("meta_session_id");

    db.close();
  });

  test("migrations are idempotent (can run twice)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "unified-agent-distill-test-"));
    const dbPath = join(dir, "db.sqlite");

    // First construction creates tables
    const db1 = new SessionDb(dbPath);
    db1.close();

    // Second construction should not throw
    const db2 = new SessionDb(dbPath);
    const rawDb = (db2 as any).db as import("bun:sqlite").Database;
    const tables = rawDb
      .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const tableNames = tables.map((t) => t.name);

    expect(tableNames).toContain("chunks");
    expect(tableNames).toContain("assessments");
    expect(tableNames).toContain("external_sessions");
    expect(tableNames).toContain("_sync_queue");

    db2.close();
  });
});
