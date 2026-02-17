/**
 * Resolve a real filesystem path to Claude Code project directory names.
 *
 * Claude Code encodes project paths by replacing `/`, `.`, and `_` with `-`.
 * For example:
 *   /Volumes/VRAM/10-19_Work/10_Hacker_Valley_Media/10.09_technology
 *   → -Volumes-VRAM-10-19-Work-10-Hacker-Valley-Media-10-09-technology
 *
 * This module provides forward encoding and directory matching.
 */

import { readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

/**
 * Encode a filesystem path to Claude Code's project directory name format.
 * Replaces `/`, `.`, and `_` with `-`.
 */
export function encodeProjectPath(fsPath: string): string {
  // Normalize: resolve to absolute, remove trailing slash
  const normalized = resolve(fsPath).replace(/\/+$/, "");
  // Replace /, ., _ with -
  return normalized.replace(/[\/._]/g, "-");
}

/**
 * List all project directory names under ~/.claude/projects/.
 */
function listClaudeProjectDirs(): string[] {
  const projectsDir = resolve(homedir(), ".claude", "projects");
  try {
    return readdirSync(projectsDir);
  } catch {
    return [];
  }
}

/**
 * Resolve a real filesystem path to matching Claude project directory names.
 *
 * Returns all project directory names under ~/.claude/projects/ that match
 * the encoded version of the given path (exact match or prefix match for
 * subdirectory projects).
 *
 * @param cwd - The real filesystem path to resolve (e.g., /Volumes/VRAM/.../hvm-website-payloadcms)
 * @returns Array of matching project directory names (not full paths)
 */
export function resolveClaudeProjectDirs(cwd: string): string[] {
  // Resolve symlinks if the path exists
  let resolvedPath: string;
  try {
    resolvedPath = realpathSync(cwd);
  } catch {
    // Path doesn't exist on disk — use as-is
    resolvedPath = resolve(cwd);
  }

  const encoded = encodeProjectPath(resolvedPath);
  const allDirs = listClaudeProjectDirs();

  // Match: exact or the project dir starts with encoded path
  // (handles subdirectory projects like .../hvm-website-payloadcms/src/endpoints)
  return allDirs.filter((dir) => dir === encoded || dir.startsWith(encoded + "-"));
}

/**
 * Get full paths to project directories that contain session files.
 * Claude Code stores JSONL files either:
 *   - Directly in ~/.claude/projects/<encoded>/*.jsonl
 *   - Or in ~/.claude/projects/<encoded>/sessions/*.jsonl
 *
 * @param cwd - The real filesystem path
 * @returns Array of absolute paths to project directories that contain sessions
 */
export function getProjectSessionDirs(cwd: string): string[] {
  const projectsBase = resolve(homedir(), ".claude", "projects");
  const matchingDirs = resolveClaudeProjectDirs(cwd);

  const projectDirs: string[] = [];
  for (const dir of matchingDirs) {
    const projectDir = resolve(projectsBase, dir);
    try {
      const st = statSync(projectDir);
      if (st.isDirectory()) {
        projectDirs.push(projectDir);
      }
    } catch {
      // Directory doesn't exist — skip
    }
  }

  return projectDirs;
}
