import { readFile } from "node:fs/promises";
import { getJsonlPath } from "../storage/jsonl";
import type { CanonicalEvent } from "../session/types";

export interface ReplayReport {
  sessionId: string;
  jsonlPath: string;
  totalEvents: number;
  byType: Record<string, number>;
  deterministicOrder: boolean;
  warnings: string[];
}

export async function replayCanonicalSession(sessionId: string): Promise<ReplayReport> {
  const jsonlPath = getJsonlPath(sessionId);
  const raw = await readFile(jsonlPath, "utf-8");
  const events = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as CanonicalEvent);

  const byType: Record<string, number> = {};
  let deterministicOrder = true;
  const warnings: string[] = [];

  let prevTs = "";
  for (const event of events) {
    byType[event.type] = (byType[event.type] || 0) + 1;
    if (prevTs && event.ts < prevTs) {
      deterministicOrder = false;
    }
    prevTs = event.ts;
  }

  if (!deterministicOrder) {
    warnings.push("timestamp order is not strictly monotonic");
  }

  if ((byType.control_request || 0) !== (byType.control_response || 0)) {
    warnings.push("control_request/control_response counts differ");
  }

  return {
    sessionId,
    jsonlPath,
    totalEvents: events.length,
    byType,
    deterministicOrder,
    warnings,
  };
}
