import type { ProviderName } from "../session/types";
import type { PermissionMode } from "../providers/types";
import type { Adapter } from "../adapters/base";
import { OutboundQueue } from "./outboundQueue";
import { PendingPermissions } from "./pendingPermissions";
import { ReplayBuffer } from "./replayBuffer";

export interface CorrelatedRequest {
  requestId: string;
  subtype: string;
  startedAt: number;
}

export interface GatewaySessionState {
  sessionId: string;
  metaSessionId: string;
  provider: ProviderName;
  cwd: string;
  project: string;
  model?: string;
  permissionMode: PermissionMode;
  maxThinkingTokens?: number;
  brainUrl?: string;
  gatewaySessionId: string;
  providerSessionId?: string;
  envVars?: Record<string, string>;
  adapter: Adapter;
  connected: boolean;
  lastSeenEpoch: number;
  replay: ReplayBuffer;
  outbound: OutboundQueue;
  pendingPermissions: PendingPermissions;
  pendingRequests: Map<string, CorrelatedRequest>;
}

export class SessionRegistry {
  private readonly bySessionId = new Map<string, GatewaySessionState>();

  upsert(state: GatewaySessionState): GatewaySessionState {
    this.bySessionId.set(state.sessionId, state);
    return state;
  }

  get(sessionId: string): GatewaySessionState | undefined {
    return this.bySessionId.get(sessionId);
  }

  require(sessionId: string): GatewaySessionState {
    const value = this.bySessionId.get(sessionId);
    if (!value) {
      throw new Error(`session not initialized: ${sessionId}`);
    }
    return value;
  }

  setConnected(sessionId: string, connected: boolean): void {
    const value = this.require(sessionId);
    value.connected = connected;
    value.lastSeenEpoch = Date.now();
  }

  touch(sessionId: string): void {
    const value = this.require(sessionId);
    value.lastSeenEpoch = Date.now();
  }

  delete(sessionId: string): void {
    this.bySessionId.delete(sessionId);
  }

  list(): GatewaySessionState[] {
    return [...this.bySessionId.values()];
  }
}
