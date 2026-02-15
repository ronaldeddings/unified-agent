import { mkdirSync } from "node:fs";
import { Database } from "bun:sqlite";
import { dirname } from "node:path";
import { getSqlitePath } from "../util/paths";
import type { CanonicalEvent, MetaSession, ProviderName } from "../session/types";
import { runDistillMigrations } from "./distillMigrations.ts";

export class SessionDb {
  private db: Database;

  constructor(dbPath = getSqlitePath()) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.run("PRAGMA journal_mode = WAL;");
    this.ensureSchema();
  }

  /** Expose raw bun:sqlite Database for modules that need direct access (e.g. DefensiveClaudeMemClient). */
  getDb(): Database {
    return this.db;
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
        active_model TEXT,
        brain_url TEXT,
        brain_provider TEXT,
        gateway_session_id TEXT,
        provider_session_id TEXT
      );

      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        meta_session_id TEXT NOT NULL,
        ts TEXT NOT NULL,
        provider TEXT NOT NULL,
        type TEXT NOT NULL,
        text TEXT NOT NULL,
        payload_json TEXT,
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
    this.ensureColumn("meta_sessions", "active_model", "TEXT");
    this.ensureColumn("meta_sessions", "brain_url", "TEXT");
    this.ensureColumn("meta_sessions", "brain_provider", "TEXT");
    this.ensureColumn("meta_sessions", "gateway_session_id", "TEXT");
    this.ensureColumn("meta_sessions", "provider_session_id", "TEXT");
    this.ensureColumn("events", "payload_json", "TEXT");
    // Distillation scoring columns (Phase 1)
    this.ensureColumn("events", "importance_score", "REAL");
    this.ensureColumn("events", "chunk_id", "TEXT");
    this.ensureColumn("events", "consensus_score", "REAL");
    // Distillation tables (Phase 1)
    runDistillMigrations(this.db);
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    const hasColumn = columns.some((c) => c.name === column);
    if (!hasColumn) {
      this.db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
    }
  }

  createMetaSession(s: MetaSession): void {
    this.db
      .prepare(
        `INSERT INTO meta_sessions (
          id, project, cwd, created_at_epoch, active_provider, active_model,
          brain_url, brain_provider, gateway_session_id, provider_session_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        s.id,
        s.project,
        s.cwd,
        s.createdAtEpoch,
        s.activeProvider,
        s.activeModel || null,
        s.brainUrl || null,
        s.brainProvider || null,
        s.gatewaySessionId || null,
        s.providerSessionId || null
      );
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

  updateBrain(metaSessionId: string, args: { brainUrl?: string; brainProvider?: ProviderName; gatewaySessionId?: string }): void {
    this.db
      .prepare("UPDATE meta_sessions SET brain_url = ?, brain_provider = ?, gateway_session_id = ? WHERE id = ?")
      .run(
        (args.brainUrl || "").trim() || null,
        args.brainProvider || null,
        (args.gatewaySessionId || "").trim() || null,
        metaSessionId
      );
  }

  updateProviderSessionId(metaSessionId: string, providerSessionId?: string): void {
    this.db
      .prepare("UPDATE meta_sessions SET provider_session_id = ? WHERE id = ?")
      .run((providerSessionId || "").trim() || null, metaSessionId);
  }

  getMetaSession(id: string): MetaSession | null {
    const row = this.db
      .query(
        `SELECT
          id, project, cwd, created_at_epoch, active_provider, active_model,
          brain_url, brain_provider, gateway_session_id, provider_session_id
         FROM meta_sessions WHERE id = ?`
      )
      .get(id) as any;
    if (!row) return null;
    return {
      id: row.id,
      project: row.project,
      cwd: row.cwd,
      createdAtEpoch: row.created_at_epoch,
      activeProvider: row.active_provider as ProviderName,
      activeModel: row.active_model || undefined,
      brainUrl: row.brain_url || undefined,
      brainProvider: row.brain_provider || undefined,
      gatewaySessionId: row.gateway_session_id || undefined,
      providerSessionId: row.provider_session_id || undefined,
    };
  }

  listMetaSessions(limit = 20): MetaSession[] {
    const rows = this.db
      .query(
        `SELECT
          id, project, cwd, created_at_epoch, active_provider, active_model,
          brain_url, brain_provider, gateway_session_id, provider_session_id
         FROM meta_sessions ORDER BY created_at_epoch DESC LIMIT ?`
      )
      .all(limit) as any[];
    return rows.map((r) => ({
      id: r.id,
      project: r.project,
      cwd: r.cwd,
      createdAtEpoch: r.created_at_epoch,
      activeProvider: r.active_provider as ProviderName,
      activeModel: r.active_model || undefined,
      brainUrl: r.brain_url || undefined,
      brainProvider: r.brain_provider || undefined,
      gatewaySessionId: r.gateway_session_id || undefined,
      providerSessionId: r.provider_session_id || undefined,
    }));
  }

  insertEvent(e: CanonicalEvent, createdAtEpoch = Date.now()): void {
    this.db
      .prepare(
        `INSERT INTO events (meta_session_id, ts, provider, type, text, payload_json, project, cwd, raw_json, created_at_epoch)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        e.metaSessionId,
        e.ts,
        e.provider,
        e.type,
        e.text,
        e.payload === undefined ? null : JSON.stringify(e.payload),
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
