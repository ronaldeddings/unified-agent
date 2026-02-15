/**
 * SQLite schema migrations for conversation distillation.
 * Creates tables: chunks, assessments, external_sessions, chunk_fts, _sync_queue.
 */

import type { Database } from "bun:sqlite";

export function runDistillMigrations(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS chunks (
      id TEXT PRIMARY KEY,
      meta_session_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      start_event_index INTEGER NOT NULL,
      end_event_index INTEGER NOT NULL,
      importance_avg REAL,
      consensus_score REAL,
      token_count INTEGER,
      summary TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (meta_session_id) REFERENCES meta_sessions(id)
    );

    CREATE TABLE IF NOT EXISTS assessments (
      id TEXT PRIMARY KEY,
      chunk_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      score REAL NOT NULL,
      rationale TEXT,
      model TEXT,
      tokens_used INTEGER,
      latency_ms INTEGER,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (chunk_id) REFERENCES chunks(id)
    );

    CREATE TABLE IF NOT EXISTS external_sessions (
      id TEXT PRIMARY KEY,
      platform TEXT NOT NULL,
      original_path TEXT NOT NULL,
      original_session_id TEXT,
      event_count INTEGER,
      imported_at TEXT DEFAULT (datetime('now')),
      meta_session_id TEXT,
      FOREIGN KEY (meta_session_id) REFERENCES meta_sessions(id)
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS chunk_fts USING fts5(
      chunk_id,
      content
    );

    CREATE TABLE IF NOT EXISTS _sync_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      operation TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      synced_at TEXT
    );
  `);
}
