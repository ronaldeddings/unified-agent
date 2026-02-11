import { homedir } from "node:os";
import { join } from "node:path";

export function getDataDir(): string {
  return process.env.UNIFIED_AGENT_DATA_DIR || join(homedir(), ".unified-agent");
}

export function getSessionsDir(): string {
  return join(getDataDir(), "sessions");
}

export function getSqlitePath(): string {
  return join(getDataDir(), "sessions.db");
}

export function getGatewayStatePath(): string {
  return join(getDataDir(), "gateway-state.json");
}
