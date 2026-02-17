/**
 * Distill Loader — discovers and loads distilled conversation JSONL files.
 *
 * Used by `:distill load` to find the latest build for a project and parse
 * it into structured turns that can be injected into provider sessions.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { getDataDir } from "../util/paths.ts";

/** A single turn from a loaded distilled conversation. */
export interface DistilledTurn {
  type: "user" | "assistant";
  uuid: string;
  parentUuid: string | null;
  sessionId: string;
  cwd: string;
  timestamp: string;
  content: string;
}

/** A fully loaded distilled conversation with metadata. */
export interface DistilledConversation {
  /** Absolute path to the JSONL file. */
  filePath: string;
  /** Project working directory from the conversation. */
  cwd: string;
  /** Session ID from the conversation. */
  sessionId: string;
  /** Timestamp of the first event. */
  createdAt: string;
  /** Parsed conversation turns. */
  turns: DistilledTurn[];
  /** Total character count of all content. */
  totalChars: number;
  /** Number of topic turns (user Q + assistant A pairs after preamble). */
  topicCount: number;
}

/**
 * Find the most recent distilled build JSONL for a given project.
 *
 * Searches ~/.unified-agent/distilled/ for *-build.jsonl files,
 * reads the cwd field from the first line, and returns the most
 * recent match (by filename timestamp).
 *
 * @param cwd - Project directory to match. If not provided, returns the latest build regardless of project.
 * @returns Absolute path to the latest matching build, or null if none found.
 */
export function findLatestBuild(cwd?: string): string | null {
  const distilledDir = join(getDataDir(), "distilled");

  let files: string[];
  try {
    files = readdirSync(distilledDir).filter((f) => f.endsWith("-build.jsonl"));
  } catch {
    return null;
  }

  if (files.length === 0) return null;

  // Sort descending by filename (timestamps sort lexicographically)
  files.sort((a, b) => b.localeCompare(a));

  if (!cwd) {
    // No project filter — return the most recent build
    return join(distilledDir, files[0]);
  }

  // Normalize cwd for comparison (strip trailing slash)
  const normalizedCwd = cwd.replace(/\/+$/, "");

  // Find the most recent build matching this project
  for (const file of files) {
    const filePath = join(distilledDir, file);
    try {
      const firstLine = readFileSync(filePath, "utf-8").split("\n")[0];
      if (!firstLine) continue;
      const obj = JSON.parse(firstLine);
      const fileCwd = (obj.cwd || "").replace(/\/+$/, "");
      if (fileCwd === normalizedCwd) {
        return filePath;
      }
    } catch {
      continue;
    }
  }

  return null;
}

/**
 * Load a distilled conversation JSONL file into structured turns.
 *
 * @param filePath - Absolute path to the JSONL file.
 * @returns Parsed conversation with metadata.
 * @throws If the file cannot be read or has no valid turns.
 */
export function loadDistilledConversation(filePath: string): DistilledConversation {
  const raw = readFileSync(filePath, "utf-8").trim();
  if (!raw) {
    throw new Error(`Empty file: ${filePath}`);
  }

  const lines = raw.split("\n");
  const turns: DistilledTurn[] = [];
  let sessionId = "";
  let cwd = "";
  let createdAt = "";
  let totalChars = 0;

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      const type = obj.type as "user" | "assistant";
      if (type !== "user" && type !== "assistant") continue;

      // Extract content from the message
      let content = "";
      if (type === "user") {
        content = typeof obj.message?.content === "string"
          ? obj.message.content
          : "";
      } else {
        // Assistant: content is an array of text blocks
        const blocks = Array.isArray(obj.message?.content) ? obj.message.content : [];
        content = blocks
          .filter((b: any) => b?.type === "text" && typeof b.text === "string")
          .map((b: any) => b.text)
          .join("\n");
      }

      if (!sessionId) sessionId = obj.sessionId || "";
      if (!cwd) cwd = obj.cwd || "";
      if (!createdAt) createdAt = obj.timestamp || "";

      totalChars += content.length;
      turns.push({
        type,
        uuid: obj.uuid || "",
        parentUuid: obj.parentUuid ?? null,
        sessionId: obj.sessionId || "",
        cwd: obj.cwd || "",
        timestamp: obj.timestamp || "",
        content,
      });
    } catch {
      // Skip malformed lines
      continue;
    }
  }

  if (turns.length === 0) {
    throw new Error(`No valid turns found in: ${filePath}`);
  }

  // Count topic turns: user/assistant pairs after the first preamble pair
  const topicCount = Math.max(0, Math.floor((turns.length - 2) / 2));

  return {
    filePath,
    cwd,
    sessionId,
    createdAt,
    turns,
    totalChars,
    topicCount,
  };
}

/**
 * Extract a text summary of the loaded conversation for non-Claude providers.
 * Returns a formatted context block that can be prepended to prompts.
 */
export function extractContextText(conversation: DistilledConversation): string {
  const parts: string[] = [];
  parts.push(`=== DISTILLED PROJECT CONTEXT (${conversation.cwd}) ===`);
  parts.push(`Source: ${conversation.filePath}`);
  parts.push(`Topics: ${conversation.topicCount}, Turns: ${conversation.turns.length}`);
  parts.push("");

  for (const turn of conversation.turns) {
    if (turn.type === "assistant" && turn.content.trim()) {
      parts.push(turn.content.trim());
      parts.push("");
    }
  }

  return parts.join("\n");
}
