import type { Provider } from "./types";
import type { ProviderName } from "../session/types";
import { ClaudeCliProvider } from "./claudeCli";
import { CodexCliProvider } from "./codexCli";
import { GeminiCliProvider } from "./geminiCli";
import { MockProvider } from "./mock";

export function getProvider(name: ProviderName): Provider {
  switch (name) {
    case "claude":
      return new ClaudeCliProvider();
    case "codex":
      return new CodexCliProvider();
    case "gemini":
      return new GeminiCliProvider();
    case "mock":
      return new MockProvider();
    default:
      return new MockProvider();
  }
}
