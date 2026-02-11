import { randomBytes } from "node:crypto";

// Not a spec ULID; good enough for local uniqueness and time ordering.
export function newMetaSessionId(now = Date.now()): string {
  const ts = now.toString(36).padStart(10, "0");
  const rnd = randomBytes(10).toString("hex"); // 20 chars
  return `ms_${ts}_${rnd}`;
}

