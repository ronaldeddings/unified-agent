import type { GatewaySessionState } from "./sessionRegistry";
import type { UcpEnvelope, UcpSystemEvent } from "./protocol";

export function buildHydrationPayload(state: GatewaySessionState): UcpEnvelope[] {
  const snapshot: UcpSystemEvent = {
    type: "system",
    subtype: "status",
    session_id: state.sessionId,
    payload: {
      provider: state.provider,
      model: state.model,
      permissionMode: state.permissionMode,
      maxThinkingTokens: state.maxThinkingTokens,
      gatewaySessionId: state.gatewaySessionId,
      providerSessionId: state.providerSessionId,
      connected: state.connected,
    },
  };

  const pending = state.pendingPermissions.listBySession(state.sessionId).map((p) => ({
    type: "system" as const,
    subtype: "status" as const,
    session_id: state.sessionId,
    payload: {
      pendingPermission: {
        requestId: p.requestId,
        toolName: p.request.tool_name,
        toolUseId: p.request.tool_use_id,
      },
    },
  }));

  return [snapshot, ...state.replay.getAll(), ...pending];
}
