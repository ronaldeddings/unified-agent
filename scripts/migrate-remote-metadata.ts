#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { getSqlitePath } from "../src/util/paths";

function main(): void {
  const dbPath = getSqlitePath();
  const db = new Database(dbPath);

  db.run("ALTER TABLE meta_sessions ADD COLUMN brain_url TEXT");
  db.run("ALTER TABLE meta_sessions ADD COLUMN brain_provider TEXT");
  db.run("ALTER TABLE meta_sessions ADD COLUMN gateway_session_id TEXT");
  db.run("ALTER TABLE meta_sessions ADD COLUMN provider_session_id TEXT");
  db.run("ALTER TABLE events ADD COLUMN payload_json TEXT");

  db.run(
    `UPDATE meta_sessions
     SET brain_url = COALESCE(brain_url, NULL),
         brain_provider = COALESCE(brain_provider, NULL),
         gateway_session_id = COALESCE(gateway_session_id, NULL),
         provider_session_id = COALESCE(provider_session_id, NULL)`
  );

  const count = (db.query("SELECT COUNT(*) as c FROM meta_sessions").get() as { c: number }).c;
  db.close();

  console.log(JSON.stringify({ ok: true, dbPath, metaSessions: count }, null, 2));
}

try {
  main();
} catch (err) {
  // Repeat-safe behavior: ignore duplicate-column errors and report success.
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("duplicate column name")) {
    console.log(JSON.stringify({ ok: true, warning: msg }, null, 2));
    process.exit(0);
  }
  console.error(msg);
  process.exit(1);
}
