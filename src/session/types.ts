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
  // Distillation scoring fields (Phase 1 foundation)
  importanceScore?: number;        // 0-100, assigned by importance scorer
  chunkId?: string;                // Groups events into assessment units
  assessmentScores?: Record<string, number>;  // { claude: 8.2, codex: 7.5, gemini: 8.0 }
  consensusScore?: number;         // Weighted average of assessment scores
  sourceSessionId?: string;        // Original session ID (for external ingestion)
  sourcePlatform?: "claude" | "codex" | "gemini";  // Original platform
  toolCalls?: { name: string; input?: string; output?: string }[];  // Extracted tool usage
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
