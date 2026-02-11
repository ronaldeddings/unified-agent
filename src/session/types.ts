export type ProviderName = "claude" | "codex" | "gemini" | "mock";

export type CanonicalEventType =
  | "meta_session_created"
  | "meta_session_resumed"
  | "provider_switched"
  | "model_switched"
  | "user_message"
  | "assistant_message"
  | "memory_injected"
  | "error"
  | "control_request"
  | "control_response"
  | "control_cancel_request"
  | "transport_state"
  | "permission_cancelled";

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
  payload?: unknown;
}

export type CanonicalEvent = CanonicalTextEvent;

export interface MetaSession {
  id: string;
  project: string;
  cwd: string;
  createdAtEpoch: number;
  activeProvider: ProviderName;
  activeModel?: string;
  brainUrl?: string;
  brainProvider?: ProviderName;
  gatewaySessionId?: string;
  providerSessionId?: string;
}
