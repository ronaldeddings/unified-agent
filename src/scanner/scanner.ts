/**
 * Session file scanner.
 *
 * Discovers session files across all three platforms (Claude, Codex, Gemini)
 * and the unified-agent's own sessions. Resolves ~ to $HOME, globs each
 * platform pattern, and returns ScannedSession[] sorted by modifiedAt descending.
 */

import { Glob } from "bun";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import { stat } from "node:fs/promises";
import { PLATFORM_SESSION_PATHS, type ScannedPlatform, type ScannedSession } from "./paths.ts";

/**
 * Resolve ~ to $HOME in a glob pattern.
 */
function resolveHome(pattern: string): string {
  if (pattern.startsWith("~/")) {
    return resolve(homedir(), pattern.slice(2));
  }
  return pattern;
}

/**
 * Extract a session ID from a file path.
 * Strips directory and extension to get the base name.
 */
function extractSessionId(filePath: string): string {
  const base = basename(filePath);
  const dotIdx = base.lastIndexOf(".");
  return dotIdx > 0 ? base.slice(0, dotIdx) : base;
}

/**
 * Scan a single platform's session paths for files.
 */
async function scanPlatform(
  platform: ScannedPlatform,
  patterns: string[],
): Promise<ScannedSession[]> {
  const results: ScannedSession[] = [];

  for (const rawPattern of patterns) {
    const resolvedPattern = resolveHome(rawPattern);

    // Split into base directory and glob pattern
    // Find the first segment with a wildcard
    const segments = resolvedPattern.split("/");
    let baseDir = "/";
    let globPattern = "";
    let foundWild = false;

    for (let i = 0; i < segments.length; i++) {
      if (!foundWild && !segments[i].includes("*") && !segments[i].includes("?")) {
        baseDir = baseDir === "/" ? `/${segments[i]}` : `${baseDir}/${segments[i]}`;
      } else {
        foundWild = true;
        globPattern = globPattern ? `${globPattern}/${segments[i]}` : segments[i];
      }
    }

    if (!globPattern) continue;

    // Check if base directory exists
    try {
      await stat(baseDir);
    } catch {
      // Directory doesn't exist — skip silently
      continue;
    }

    const glob = new Glob(globPattern);
    for await (const match of glob.scan({ cwd: baseDir, absolute: true })) {
      try {
        const fileStat = await stat(match);
        results.push({
          platform,
          filePath: match,
          fileSize: fileStat.size,
          modifiedAt: fileStat.mtime,
          sessionId: extractSessionId(match),
        });
      } catch {
        // File disappeared between glob and stat — skip
      }
    }
  }

  return results;
}

export interface ScanOptions {
  /** Limit to specific platforms. Default: all. */
  platforms?: ScannedPlatform[];
  /** Minimum file size in bytes to include. Default: 0. */
  minFileSize?: number;
  /** Maximum number of results to return. Default: unlimited. */
  limit?: number;
}

/**
 * Scan all configured platform session directories for session files.
 * Returns ScannedSession[] sorted by modifiedAt descending (most recent first).
 */
export async function scanSessions(
  options: ScanOptions = {},
): Promise<ScannedSession[]> {
  const platforms = options.platforms ?? (Object.keys(PLATFORM_SESSION_PATHS) as ScannedPlatform[]);
  const minSize = options.minFileSize ?? 0;

  // Scan all platforms in parallel
  const platformResults = await Promise.all(
    platforms.map((p) => scanPlatform(p, PLATFORM_SESSION_PATHS[p])),
  );

  // Flatten and filter
  let all = platformResults.flat();

  if (minSize > 0) {
    all = all.filter((s) => s.fileSize >= minSize);
  }

  // Sort by modifiedAt descending
  all.sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());

  // Apply limit
  if (options.limit && options.limit > 0) {
    all = all.slice(0, options.limit);
  }

  return all;
}
