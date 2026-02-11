import { mkdirSync } from "node:fs";
import { Database } from "bun:sqlite";
import { dirname } from "node:path";
import { getSqlitePath } from "../util/paths";
import type { CanonicalEvent, MetaSession, ProviderName } from "../session/types";

export class SessionDb {
  private db: Database;

  constructor(dbPath = getSqlitePath()) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.run("PRAGMA journal_mode = WAL;");
    this.ensureSchema();
  }

  close(): void {
    this.db.close();
  }

  private ensureSchema(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS meta_sessions (
        id TEXT PRIMARY KEY,
        project TEXT NOT NULL,
        cwd TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL,
        active_provider TEXT NOT NULL,
        active_model TEXT
      );

      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        meta_session_id TEXT NOT NULL,
        ts TEXT NOT NULL,
        provider TEXT NOT NULL,
        type TEXT NOT NULL,
        text TEXT NOT NULL,
        project TEXT NOT NULL,
        cwd TEXT NOT NULL,
        raw_json TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL,
        FOREIGN KEY(meta_session_id) REFERENCES meta_sessions(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_events_meta_session_id ON events(meta_session_id);
      CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at_epoch DESC);
    `);

    const columns = this.db.query("PRAGMA table_info(meta_sessions)").all() as Array<{ name: string }>;
    const hasActiveModel = columns.some((c) => c.name === "active_model");
    if (!hasActiveModel) {
      this.db.run("ALTER TABLE meta_sessions ADD COLUMN active_model TEXT;");
    }
  }

  createMetaSession(s: MetaSession): void {
    this.db
      .prepare(
        `INSERT INTO meta_sessions (id, project, cwd, created_at_epoch, active_provider, active_model)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(s.id, s.project, s.cwd, s.createdAtEpoch, s.activeProvider, s.activeModel || null);
  }

  updateActiveProvider(metaSessionId: string, provider: ProviderName): void {
    this.db
      .prepare("UPDATE meta_sessions SET active_provider = ? WHERE id = ?")
      .run(provider, metaSessionId);
  }

  updateActiveModel(metaSessionId: string, model?: string): void {
    this.db
      .prepare("UPDATE meta_sessions SET active_model = ? WHERE id = ?")
      .run((model || "").trim() || null, metaSessionId);
  }

  getMetaSession(id: string): MetaSession | null {
    const row = this.db
      .query("SELECT id, project, cwd, created_at_epoch, active_provider, active_model FROM meta_sessions WHERE id = ?")
      .get(id) as any;
    if (!row) return null;
    return {
      id: row.id,
      project: row.project,
      cwd: row.cwd,
      createdAtEpoch: row.created_at_epoch,
      activeProvider: row.active_provider as ProviderName,
      activeModel: row.active_model || undefined,
    };
  }

  listMetaSessions(limit = 20): MetaSession[] {
    const rows = this.db
      .query(
        "SELECT id, project, cwd, created_at_epoch, active_provider, active_model FROM meta_sessions ORDER BY created_at_epoch DESC LIMIT ?"
      )
      .all(limit) as any[];
    return rows.map((r) => ({
      id: r.id,
      project: r.project,
      cwd: r.cwd,
      createdAtEpoch: r.created_at_epoch,
      activeProvider: r.active_provider as ProviderName,
      activeModel: r.active_model || undefined,
    }));
  }

  insertEvent(e: CanonicalEvent, createdAtEpoch = Date.now()): void {
    this.db
      .prepare(
        `INSERT INTO events (meta_session_id, ts, provider, type, text, project, cwd, raw_json, created_at_epoch)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        e.metaSessionId,
        e.ts,
        e.provider,
        e.type,
        e.text,
        e.project,
        e.cwd,
        JSON.stringify(e),
        createdAtEpoch
      );
  }

  getRecentEvents(metaSessionId: string, limit = 50): CanonicalEvent[] {
    const rows = this.db
      .query("SELECT raw_json FROM events WHERE meta_session_id = ? ORDER BY created_at_epoch DESC LIMIT ?")
      .all(metaSessionId, limit) as any[];
    return rows.map((r) => JSON.parse(r.raw_json));
  }
}
