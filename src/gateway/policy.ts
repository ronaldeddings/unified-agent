import { GatewayError } from "./errors";

export interface GatewayPolicyConfig {
  allowInsecureWs?: boolean;
  allowlistPatterns?: string[];
  maxPayloadBytes?: number;
  maxPendingRequestsPerSession?: number;
  maxControlRequestsPerMinute?: number;
}

export interface CanUseToolDecision {
  behavior: "allow" | "deny";
  updatedInput?: Record<string, unknown>;
  updatedPermissions?: unknown;
}

export class GatewayRateLimiter {
  private readonly maxPerMinute: number;
  private readonly hits = new Map<string, number[]>();

  constructor(maxPerMinute: number) {
    this.maxPerMinute = Math.max(1, maxPerMinute);
  }

  accept(sessionId: string, now = Date.now()): boolean {
    const windowStart = now - 60_000;
    const timestamps = this.hits.get(sessionId) || [];
    const kept = timestamps.filter((t) => t >= windowStart);
    if (kept.length >= this.maxPerMinute) {
      this.hits.set(sessionId, kept);
      return false;
    }
    kept.push(now);
    this.hits.set(sessionId, kept);
    return true;
  }
}

export function validateBrainUrl(urlRaw: string, cfg: GatewayPolicyConfig): void {
  let url: URL;
  try {
    url = new URL(urlRaw);
  } catch {
    throw new GatewayError("INVALID_ARGUMENT", `invalid brain url: ${urlRaw}`);
  }

  if (url.protocol === "ws:") {
    if (!cfg.allowInsecureWs && process.env.UNIFIED_AGENT_ALLOW_INSECURE_BRAIN !== "1") {
      throw new GatewayError("POLICY_DENIED", "ws:// brain urls are disabled; use wss:// or set UNIFIED_AGENT_ALLOW_INSECURE_BRAIN=1");
    }
  } else if (url.protocol !== "wss:") {
    throw new GatewayError("INVALID_ARGUMENT", "brain url must use ws:// or wss://");
  }

  const allowlist = cfg.allowlistPatterns || loadAllowlistFromEnv();
  if (allowlist.length > 0) {
    const matched = allowlist.some((pattern) => {
      try {
        return new RegExp(pattern).test(url.toString());
      } catch {
        return false;
      }
    });
    if (!matched) {
      throw new GatewayError("POLICY_DENIED", "brain url does not match UNIFIED_AGENT_BRAIN_URL_ALLOWLIST");
    }
  }
}

export function enforcePayloadSize(raw: string, cfg: GatewayPolicyConfig): void {
  const max = cfg.maxPayloadBytes || 512_000;
  if (Buffer.byteLength(raw, "utf-8") > max) {
    throw new GatewayError("INVALID_ARGUMENT", `payload exceeds max size (${max} bytes)`);
  }
}

export function validateCanUseToolDecision(input: unknown): CanUseToolDecision {
  if (!input || typeof input !== "object") {
    throw new GatewayError("INVALID_ARGUMENT", "can_use_tool decision must be an object");
  }
  const o = input as Record<string, unknown>;
  const behavior = o.behavior;
  if (behavior !== "allow" && behavior !== "deny") {
    throw new GatewayError("INVALID_ARGUMENT", "can_use_tool.behavior must be allow or deny");
  }

  const updatedInput = o.updatedInput;
  if (updatedInput !== undefined && (!updatedInput || typeof updatedInput !== "object" || Array.isArray(updatedInput))) {
    throw new GatewayError("INVALID_ARGUMENT", "can_use_tool.updatedInput must be an object when present");
  }

  return {
    behavior,
    updatedInput: updatedInput as Record<string, unknown> | undefined,
    updatedPermissions: o.updatedPermissions,
  };
}

function loadAllowlistFromEnv(): string[] {
  const raw = (process.env.UNIFIED_AGENT_BRAIN_URL_ALLOWLIST || "").trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
