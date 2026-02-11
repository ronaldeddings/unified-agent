import { mkdir, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { getSessionsDir } from "../util/paths";
import type { CanonicalEvent } from "../session/types";

export function getJsonlPath(metaSessionId: string): string {
  return join(getSessionsDir(), `${metaSessionId}.jsonl`);
}

export async function appendEventJsonl(metaSessionId: string, event: CanonicalEvent): Promise<void> {
  const dir = getSessionsDir();
  await mkdir(dir, { recursive: true });

  const path = getJsonlPath(metaSessionId);
  const line = JSON.stringify(event) + "\n";
  // Use node:fs appendFile to guarantee ordering when awaited.
  await appendFile(path, line, "utf-8");
}
