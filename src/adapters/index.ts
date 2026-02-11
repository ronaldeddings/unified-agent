import type { ProviderName } from "../session/types";
import type { Adapter } from "./base";
import { ClaudeNativeAdapter } from "./claudeNative";
import { CodexCompatAdapter } from "./codexCompat";
import { GeminiCompatAdapter } from "./geminiCompat";
import { MockCompatAdapter } from "./mockCompat";

export function getAdapter(provider: ProviderName): Adapter {
  switch (provider) {
    case "claude":
      return new ClaudeNativeAdapter();
    case "codex":
      return new CodexCompatAdapter();
    case "gemini":
      return new GeminiCompatAdapter();
    case "mock":
      return new MockCompatAdapter();
    default:
      return new MockCompatAdapter();
  }
}
