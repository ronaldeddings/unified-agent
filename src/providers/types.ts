import type { ProviderName } from "../session/types";

export interface ProviderResponse {
  text: string;
  raw?: unknown;
}

export interface Provider {
  name: ProviderName;
  ask(prompt: string, opts: { cwd: string; model?: string }): Promise<ProviderResponse>;
}

