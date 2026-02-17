import type { ProviderName } from "../session/types";

export interface ProviderResponse {
  text: string;
  raw?: unknown;
}

export type PermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions";

export interface ProviderAskOptions {
  cwd: string;
  model?: string;
  sdkUrl?: string;
  brainSessionId?: string;
  permissionMode?: PermissionMode;
  maxThinkingTokens?: number;
  signal?: AbortSignal;
  /** Path to a distilled JSONL file for --resume (Claude) or context injection (other providers). */
  resumePath?: string;
}

export interface ProviderCapabilities {
  supportsSdkUrl?: boolean;
  supportsInterrupt?: boolean;
  supportsSetModel?: boolean;
  supportsPermissionMode?: boolean;
}

export interface Provider {
  name: ProviderName;
  capabilities?: ProviderCapabilities;
  ask(prompt: string, opts: ProviderAskOptions): Promise<ProviderResponse>;
  interrupt?(sessionId?: string): Promise<void>;
}
