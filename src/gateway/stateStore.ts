import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ProviderName } from "../session/types";
import { getAdapter } from "../adapters";
import type { GatewaySessionState } from "./sessionRegistry";
import type { PermissionMode } from "../providers/types";
import type { UcpEnvelope } from "./protocol";
import { getGatewayStatePath } from "../util/paths";
import { OutboundQueue, type QueuedEnvelope } from "./outboundQueue";
import { PendingPermissions, type PendingPermission } from "./pendingPermissions";
import { ReplayBuffer } from "./replayBuffer";

interface PersistedGatewaySession {
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
  connected: boolean;
  lastSeenEpoch: number;
  replay: UcpEnvelope[];
  outbound: QueuedEnvelope[];
  pendingPermissions: PendingPermission[];
  pendingRequests: Array<{ requestId: string; subtype: string; startedAt: number }>;
}

interface PersistedGatewayState {
  version: 1;
  savedAtEpoch: number;
  sessions: PersistedGatewaySession[];
}

export class GatewayStateStore {
  constructor(private readonly path = getGatewayStatePath()) {}

  load(): GatewaySessionState[] {
    let raw = "";
    try {
      raw = readFileSync(this.path, "utf-8");
    } catch {
      return [];
    }

    let parsed: PersistedGatewayState;
    try {
      parsed = JSON.parse(raw) as PersistedGatewayState;
    } catch {
      this.quarantineCorruptFile();
      return [];
    }

    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.sessions)) {
      return [];
    }

    const out: GatewaySessionState[] = [];
    for (const s of parsed.sessions) {
      try {
        const provider = s.provider;
        const adapter = getAdapter(provider);
        out.push({
          sessionId: s.sessionId,
          metaSessionId: s.metaSessionId,
          provider,
          cwd: s.cwd,
          project: s.project,
          model: s.model,
          permissionMode: s.permissionMode,
          maxThinkingTokens: s.maxThinkingTokens,
          brainUrl: s.brainUrl,
          gatewaySessionId: s.gatewaySessionId,
          providerSessionId: s.providerSessionId,
          envVars: s.envVars || {},
          adapter,
          connected: false,
          lastSeenEpoch: s.lastSeenEpoch,
          replay: ReplayBuffer.fromArray(s.replay || []),
          outbound: OutboundQueue.fromArray(s.outbound || []),
          pendingPermissions: PendingPermissions.fromArray(s.pendingPermissions || []),
          pendingRequests: new Map((s.pendingRequests || []).map((r) => [r.requestId, r])),
        });
      } catch {
        // skip malformed session entries
      }
    }

    return out;
  }

  save(states: GatewaySessionState[]): void {
    const payload: PersistedGatewayState = {
      version: 1,
      savedAtEpoch: Date.now(),
      sessions: states.map((s) => ({
        sessionId: s.sessionId,
        metaSessionId: s.metaSessionId,
        provider: s.provider,
        cwd: s.cwd,
        project: s.project,
        model: s.model,
        permissionMode: s.permissionMode,
        maxThinkingTokens: s.maxThinkingTokens,
        brainUrl: s.brainUrl,
        gatewaySessionId: s.gatewaySessionId,
        providerSessionId: s.providerSessionId,
        envVars: s.envVars || {},
        connected: s.connected,
        lastSeenEpoch: s.lastSeenEpoch,
        replay: s.replay.getAll(),
        outbound: s.outbound.toArray(),
        pendingPermissions: s.pendingPermissions.toArray(),
        pendingRequests: [...s.pendingRequests.values()],
      })),
    };

    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf-8");
    renameSync(tmp, this.path);
  }

  clear(): void {
    rmSync(this.path, { force: true });
  }

  private quarantineCorruptFile(): void {
    try {
      const corrupted = `${this.path}.corrupt.${Date.now()}`;
      renameSync(this.path, corrupted);
    } catch {
      // ignore
    }
  }
}
