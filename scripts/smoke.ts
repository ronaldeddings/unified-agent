#!/usr/bin/env bun
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

import { SessionManager } from "../src/session/manager";
import { getJsonlPath } from "../src/storage/jsonl";
import { getProvider } from "../src/providers";
import { ClaudeMemClient } from "../src/memory/claudeMemClient";

function boolEnv(name: string, fallback = false): boolean {
  const v = (process.env[name] || "").trim().toLowerCase();
  if (!v) return fallback;
  return v === "1" || v === "true" || v === "yes";
}

async function main(): Promise<void> {
  const projectCwd = process.cwd();
  const dataDir = await mkdtemp(join(tmpdir(), "pai-ut-data-"));
  process.env.PAI_UT_DATA_DIR = dataDir;

  const sm = new SessionManager();
  const s = await sm.newSession({ project: "smoke", cwd: projectCwd, provider: "mock" });
  await sm.recordUser("hello <private>secret</private> sk-1234567890abcdefghijklmnop");
  await sm.recordAssistant("ok");

  const jsonlPath = getJsonlPath(s.id);
  const jsonl = await readFile(jsonlPath, "utf-8");
  const lines = jsonl.split("\n").filter(Boolean);
  for (const l of lines) JSON.parse(l);

  const dbPath = join(dataDir, "sessions.db");
  const db = new Database(dbPath);
  const msCount = (db.query("SELECT COUNT(*) as c FROM meta_sessions").get() as any).c;
  const evCount = (db.query("SELECT COUNT(*) as c FROM events").get() as any).c;
  db.close();

  const mem = new ClaudeMemClient();
  const memHealth = await mem.health();

  const providersEnabled = boolEnv("PAI_UT_SMOKE_PROVIDERS", false);
  const providerResults: Record<string, string> = {};

  if (providersEnabled) {
    const prompt = "Output exactly: PAI_UT_SMOKE_OK";
    const providers = ["claude", "gemini", "codex"] as const;
    for (const p of providers) {
      try {
        const provider = getProvider(p);
        const r = await provider.ask(prompt, { cwd: projectCwd });
        providerResults[p] = r.text.slice(0, 200);
      } catch (e) {
        providerResults[p] = `ERROR: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
  }

  console.log(
    JSON.stringify(
      {
        dataDir,
        jsonlPath,
        jsonlLines: lines.length,
        sqlite: { dbPath, metaSessions: msCount, events: evCount },
        providersEnabled,
        providers: providerResults,
        claudeMemWorkerReachable: memHealth,
      },
      null,
      2
    )
  );

  sm.close();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});

