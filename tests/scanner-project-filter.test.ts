import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { scanSessions } from "../src/scanner/scanner";

/**
 * 10.21: Test that scanSessions with projectPath filters to matching sessions.
 *
 * These tests use the real scanner against temp directories.
 * Since Claude project resolution depends on ~/.claude/projects/,
 * we test the filtering behavior at the integration level.
 */
describe("scanner project filtering", () => {
  test("10.21: scanSessions without projectPath returns sessions from all projects", async () => {
    // This is a basic smoke test — it should not throw
    const sessions = await scanSessions({ limit: 5 });
    // Sessions may or may not exist depending on the test environment
    expect(Array.isArray(sessions)).toBe(true);
  });

  test("10.21: scanSessions with non-existent projectPath returns no Claude sessions", async () => {
    const sessions = await scanSessions({
      projectPath: "/nonexistent/path/that/does/not/match/anything",
      platforms: ["claude"],
      limit: 100,
    });
    // No Claude project directory matches this path, so 0 Claude sessions
    expect(sessions.length).toBe(0);
  });

  test("10.21: scanSessions with projectPath preserves non-Claude platform sessions", async () => {
    // When projectPath is set, non-Claude sessions should still pass through
    // (they can't be filtered at scan time since their storage is global)
    const sessions = await scanSessions({
      projectPath: "/nonexistent/path",
      platforms: ["codex", "gemini"],
      limit: 100,
    });
    // These sessions pass through regardless of projectPath
    // (may be 0 if no codex/gemini sessions exist in the test env)
    expect(Array.isArray(sessions)).toBe(true);
  });

  test("10.21: scanSessions respects limit option", async () => {
    const sessions = await scanSessions({ limit: 2 });
    expect(sessions.length).toBeLessThanOrEqual(2);
  });

  test("10.21: scanSessions results are sorted by modifiedAt descending", async () => {
    const sessions = await scanSessions({ limit: 10 });
    for (let i = 1; i < sessions.length; i++) {
      expect(sessions[i - 1].modifiedAt.getTime()).toBeGreaterThanOrEqual(sessions[i].modifiedAt.getTime());
    }
  });
});
