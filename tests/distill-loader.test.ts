import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findLatestBuild, loadDistilledConversation, extractContextText } from "../src/distiller/distillLoader";

/** Helper to create a minimal valid JSONL line. */
function makeUserLine(cwd: string, content: string, uuid = "u1", parentUuid: string | null = null, sessionId = "sess1", ts = "2026-02-16T20:00:00.000Z"): string {
  return JSON.stringify({
    type: "user",
    uuid,
    parentUuid,
    sessionId,
    cwd,
    timestamp: ts,
    version: "2.1.0",
    gitBranch: "",
    isSidechain: false,
    userType: "external",
    message: { role: "user", content },
  });
}

function makeAssistantLine(cwd: string, content: string, uuid = "a1", parentUuid = "u1", sessionId = "sess1", ts = "2026-02-16T20:01:00.000Z"): string {
  return JSON.stringify({
    type: "assistant",
    uuid,
    parentUuid,
    sessionId,
    cwd,
    timestamp: ts,
    version: "2.1.0",
    gitBranch: "",
    isSidechain: false,
    userType: "external",
    message: {
      model: "claude-sonnet-4-5-20250929",
      id: "msg_test123",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: content }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 50, service_tier: "standard" },
    },
  });
}

describe("findLatestBuild", () => {
  let tmpDir: string;
  const origEnv = process.env.UNIFIED_AGENT_DATA_DIR;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `distill-loader-test-${Date.now()}`);
    mkdirSync(join(tmpDir, "distilled"), { recursive: true });
    process.env.UNIFIED_AGENT_DATA_DIR = tmpDir;
  });

  afterEach(() => {
    process.env.UNIFIED_AGENT_DATA_DIR = origEnv;
    try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  });

  test("returns null when no builds exist", () => {
    expect(findLatestBuild()).toBeNull();
  });

  test("returns latest build when no cwd filter", () => {
    const dir = join(tmpDir, "distilled");
    writeFileSync(join(dir, "2026-02-10-10-00-00-build.jsonl"), makeUserLine("/old/project", "hello"));
    writeFileSync(join(dir, "2026-02-16-20-00-00-build.jsonl"), makeUserLine("/new/project", "hello"));
    const result = findLatestBuild();
    expect(result).toBe(join(dir, "2026-02-16-20-00-00-build.jsonl"));
  });

  test("filters by cwd", () => {
    const dir = join(tmpDir, "distilled");
    writeFileSync(join(dir, "2026-02-16-20-00-00-build.jsonl"), makeUserLine("/project-a", "hello"));
    writeFileSync(join(dir, "2026-02-15-10-00-00-build.jsonl"), makeUserLine("/project-b", "hello"));
    const result = findLatestBuild("/project-b");
    expect(result).toBe(join(dir, "2026-02-15-10-00-00-build.jsonl"));
  });

  test("returns null when cwd doesn't match any build", () => {
    const dir = join(tmpDir, "distilled");
    writeFileSync(join(dir, "2026-02-16-20-00-00-build.jsonl"), makeUserLine("/project-a", "hello"));
    expect(findLatestBuild("/nonexistent")).toBeNull();
  });

  test("handles trailing slash in cwd", () => {
    const dir = join(tmpDir, "distilled");
    writeFileSync(join(dir, "2026-02-16-20-00-00-build.jsonl"), makeUserLine("/my/project", "hello"));
    expect(findLatestBuild("/my/project/")).toBe(join(dir, "2026-02-16-20-00-00-build.jsonl"));
  });

  test("ignores non-build JSONL files", () => {
    const dir = join(tmpDir, "distilled");
    writeFileSync(join(dir, "2026-02-16-20-00-00-seed.jsonl"), makeUserLine("/project", "hello"));
    expect(findLatestBuild()).toBeNull();
  });
});

describe("loadDistilledConversation", () => {
  let tmpFile: string;

  afterEach(() => {
    try { rmSync(tmpFile); } catch { /* ignore */ }
  });

  test("loads valid JSONL with user and assistant turns", () => {
    tmpFile = join(tmpdir(), `load-test-${Date.now()}.jsonl`);
    const lines = [
      makeUserLine("/my/project", "What about the architecture?", "u1", null, "sess1", "2026-02-16T20:00:00.000Z"),
      makeAssistantLine("/my/project", "The project uses a modular architecture.", "a1", "u1", "sess1", "2026-02-16T20:01:00.000Z"),
      makeUserLine("/my/project", "What about deployment?", "u2", "a1", "sess1", "2026-02-16T20:02:00.000Z"),
      makeAssistantLine("/my/project", "Deployed on Railway with auto-scaling.", "a2", "u2", "sess1", "2026-02-16T20:03:00.000Z"),
    ];
    writeFileSync(tmpFile, lines.join("\n") + "\n");

    const result = loadDistilledConversation(tmpFile);
    expect(result.turns.length).toBe(4);
    expect(result.cwd).toBe("/my/project");
    expect(result.sessionId).toBe("sess1");
    expect(result.createdAt).toBe("2026-02-16T20:00:00.000Z");
    expect(result.topicCount).toBe(1); // (4 - 2) / 2 = 1
    expect(result.totalChars).toBeGreaterThan(0);
  });

  test("throws on empty file", () => {
    tmpFile = join(tmpdir(), `load-empty-${Date.now()}.jsonl`);
    writeFileSync(tmpFile, "");
    expect(() => loadDistilledConversation(tmpFile)).toThrow("Empty file");
  });

  test("throws on file with no valid turns", () => {
    tmpFile = join(tmpdir(), `load-invalid-${Date.now()}.jsonl`);
    writeFileSync(tmpFile, '{"type":"system","data":"nope"}\n');
    expect(() => loadDistilledConversation(tmpFile)).toThrow("No valid turns");
  });

  test("skips malformed lines gracefully", () => {
    tmpFile = join(tmpdir(), `load-mixed-${Date.now()}.jsonl`);
    const lines = [
      "not json at all",
      makeUserLine("/project", "Valid user turn"),
      '{"broken": true',
      makeAssistantLine("/project", "Valid assistant turn"),
    ];
    writeFileSync(tmpFile, lines.join("\n") + "\n");

    const result = loadDistilledConversation(tmpFile);
    expect(result.turns.length).toBe(2);
  });

  test("extracts assistant content from text blocks array", () => {
    tmpFile = join(tmpdir(), `load-content-${Date.now()}.jsonl`);
    const lines = [
      makeUserLine("/project", "Tell me about testing"),
      makeAssistantLine("/project", "We use bun:test for unit tests."),
    ];
    writeFileSync(tmpFile, lines.join("\n") + "\n");

    const result = loadDistilledConversation(tmpFile);
    const assistantTurn = result.turns.find((t) => t.type === "assistant");
    expect(assistantTurn?.content).toBe("We use bun:test for unit tests.");
  });
});

describe("extractContextText", () => {
  test("produces formatted context block from loaded conversation", () => {
    const conversation = {
      filePath: "/home/user/.unified-agent/distilled/2026-02-16-build.jsonl",
      cwd: "/my/project",
      sessionId: "sess1",
      createdAt: "2026-02-16T20:00:00.000Z",
      turns: [
        { type: "user" as const, uuid: "u1", parentUuid: null, sessionId: "sess1", cwd: "/my/project", timestamp: "2026-02-16T20:00:00.000Z", content: "Question?" },
        { type: "assistant" as const, uuid: "a1", parentUuid: "u1", sessionId: "sess1", cwd: "/my/project", timestamp: "2026-02-16T20:01:00.000Z", content: "Architecture uses modular design." },
        { type: "user" as const, uuid: "u2", parentUuid: "a1", sessionId: "sess1", cwd: "/my/project", timestamp: "2026-02-16T20:02:00.000Z", content: "Deployment?" },
        { type: "assistant" as const, uuid: "a2", parentUuid: "u2", sessionId: "sess1", cwd: "/my/project", timestamp: "2026-02-16T20:03:00.000Z", content: "Deployed on Railway." },
      ],
      totalChars: 100,
      topicCount: 1,
    };

    const text = extractContextText(conversation);
    expect(text).toContain("DISTILLED PROJECT CONTEXT");
    expect(text).toContain("/my/project");
    expect(text).toContain("Architecture uses modular design.");
    expect(text).toContain("Deployed on Railway.");
    // Should NOT include user turn content
    expect(text).not.toContain("Question?");
    expect(text).not.toContain("Deployment?");
  });

  test("handles conversation with no assistant content", () => {
    const conversation = {
      filePath: "/test.jsonl",
      cwd: "/project",
      sessionId: "s1",
      createdAt: "2026-02-16T20:00:00.000Z",
      turns: [
        { type: "user" as const, uuid: "u1", parentUuid: null, sessionId: "s1", cwd: "/project", timestamp: "2026-02-16T20:00:00.000Z", content: "Hello" },
      ],
      totalChars: 5,
      topicCount: 0,
    };

    const text = extractContextText(conversation);
    expect(text).toContain("DISTILLED PROJECT CONTEXT");
    expect(text).toContain("/project");
  });
});
