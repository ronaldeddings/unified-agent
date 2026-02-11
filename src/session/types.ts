export type ProviderName = "claude" | "codex" | "gemini" | "mock";

export type CanonicalEventType =
  | "meta_session_created"
  | "meta_session_resumed"
  | "provider_switched"
  | "model_switched"
  | "user_message"
  | "assistant_message"
  | "memory_injected"
  | "error";

export interface CanonicalEventBase {
  v: 1;
  ts: string; // ISO8601
  metaSessionId: string;
  project: string;
  cwd: string;
  provider: ProviderName;
  type: CanonicalEventType;
}

export interface CanonicalTextEvent extends CanonicalEventBase {
  text: string;
}

export type CanonicalEvent = CanonicalTextEvent;

export interface MetaSession {
  id: string;
  project: string;
  cwd: string;
  createdAtEpoch: number;
  activeProvider: ProviderName;
  activeModel?: string;
}
