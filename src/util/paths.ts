import { homedir } from "node:os";
import { join } from "node:path";

export function getDataDir(): string {
  return process.env.PAI_UT_DATA_DIR || join(homedir(), ".pai-unified-terminal");
}

export function getSessionsDir(): string {
  return join(getDataDir(), "sessions");
}

export function getSqlitePath(): string {
  return join(getDataDir(), "sessions.db");
}

