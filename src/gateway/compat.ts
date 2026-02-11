import type { ProviderName } from "../session/types";
import type { ControlSubtype, UcpControlResponse, UcpSystemEvent } from "./protocol";
import { errorResponse } from "./protocol";

export function unsupportedSubtype(
  requestId: string,
  sessionId: string,
  provider: ProviderName,
  subtype: ControlSubtype
): { response: UcpControlResponse; warning: UcpSystemEvent } {
  return {
    response: errorResponse(requestId, `provider ${provider} does not support ${subtype}`, "UNKNOWN_SUBTYPE"),
    warning: {
      type: "system",
      subtype: "warning",
      session_id: sessionId,
      payload: {
        provider,
        subtype,
        compatibility: "emulated-or-unsupported",
      },
    },
  };
}
