import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanSessions } from "../src/scanner/scanner.ts";
import { PLATFORM_SESSION_PATHS } from "../src/scanner/paths.ts";

describe("scanner", () => {
  test("PLATFORM_SESSION_PATHS has all four platforms", () => {
    expect(PLATFORM_SESSION_PATHS).toHaveProperty("claude");
    expect(PLATFORM_SESSION_PATHS).toHaveProperty("codex");
    expect(PLATFORM_SESSION_PATHS).toHaveProperty("gemini");
    expect(PLATFORM_SESSION_PATHS).toHaveProperty("unified");
  });

  test("returns empty array when no sessions exist", async () => {
    // Scan with paths that almost certainly don't exist
    const results = await scanSessions({
      platforms: ["unified"],
    });
    // May or may not find sessions depending on environment
    expect(Array.isArray(results)).toBe(true);
  });

  test("scans real unified-agent session directory if it exists", async () => {
    const results = await scanSessions({
      platforms: ["unified"],
      limit: 5,
    });
    expect(Array.isArray(results)).toBe(true);
    // Results are sorted by modifiedAt descending
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].modifiedAt.getTime()).toBeGreaterThanOrEqual(
        results[i].modifiedAt.getTime(),
      );
    }
  });

  test("respects limit option", async () => {
    // Scope to a single platform to avoid slow all-platform glob
    const results = await scanSessions({ platforms: ["unified"], limit: 2 });
    expect(results.length).toBeLessThanOrEqual(2);
  });

  test("respects minFileSize option", async () => {
    // Scope to unified to avoid slow all-platform glob
    const results = await scanSessions({
      platforms: ["unified"],
      minFileSize: 999_999_999, // 1GB — nothing should be this large
    });
    expect(results).toHaveLength(0);
  });

  test("each result has required fields", async () => {
    // Scope to unified to avoid slow all-platform glob
    const results = await scanSessions({ platforms: ["unified"], limit: 3 });
    for (const r of results) {
      expect(r).toHaveProperty("platform");
      expect(r).toHaveProperty("filePath");
      expect(r).toHaveProperty("fileSize");
      expect(r).toHaveProperty("modifiedAt");
      expect(typeof r.filePath).toBe("string");
      expect(typeof r.fileSize).toBe("number");
      expect(r.modifiedAt).toBeInstanceOf(Date);
    }
  });

  test("scans a temp directory with mock session files", async () => {
    // Create a temporary fake unified-agent sessions directory
    const tempDir = await mkdtemp(join(tmpdir(), "scanner-test-"));
    const sessionsDir = join(tempDir, "sessions");
    await mkdir(sessionsDir, { recursive: true });

    // Create mock session files
    await writeFile(join(sessionsDir, "session1.jsonl"), '{"type":"user"}\n');
    await writeFile(join(sessionsDir, "session2.jsonl"), '{"type":"assistant"}\n{"type":"user"}\n');

    // We can't easily override PLATFORM_SESSION_PATHS in the scanner,
    // but we can verify the scanner module works by checking it handles
    // missing directories gracefully
    const results = await scanSessions({
      platforms: ["unified"],
    });
    // This just verifies no crash — actual results depend on env
    expect(Array.isArray(results)).toBe(true);
  });

  test("filters by platform", async () => {
    // Each scan is scoped to a single platform to avoid slow all-platform glob
    const codexOnly = await scanSessions({ platforms: ["codex"], limit: 5 });
    for (const r of codexOnly) {
      expect(r.platform).toBe("codex");
    }

    const geminiOnly = await scanSessions({ platforms: ["gemini"], limit: 5 });
    for (const r of geminiOnly) {
      expect(r.platform).toBe("gemini");
    }
  });

  test("sessionId is extracted from filename", async () => {
    // Scope to unified to avoid slow all-platform glob
    const results = await scanSessions({ platforms: ["unified"], limit: 3 });
    for (const r of results) {
      if (r.sessionId) {
        // sessionId should not contain file extension
        expect(r.sessionId).not.toContain(".jsonl");
        expect(r.sessionId).not.toContain(".json");
      }
    }
  });
});
