/**
 * Platform-specific session file locations and scanner types.
 */

export type ScannedPlatform = "claude" | "codex" | "gemini" | "unified";

export const PLATFORM_SESSION_PATHS: Record<ScannedPlatform, string[]> = {
  claude: [
    "~/.claude/projects/*/sessions/*.jsonl",
    "~/.claude/projects/*/*.jsonl",
  ],
  codex: [
    "~/.codex/sessions/*.jsonl",
  ],
  gemini: [
    "~/.gemini/sessions/*.json",
  ],
  unified: [
    "~/.unified-agent/sessions/*.jsonl",
  ],
};

export interface ScannedSession {
  platform: ScannedPlatform;
  filePath: string;
  fileSize: number;
  modifiedAt: Date;
  sessionId?: string;
}
