import { errorResponse, type UcpControlResponse } from "./protocol";

export type GatewayErrorCode =
  | "INVALID_ENVELOPE"
  | "UNKNOWN_SUBTYPE"
  | "POLICY_DENIED"
  | "NOT_INITIALIZED"
  | "REQUEST_TIMEOUT"
  | "RATE_LIMITED"
  | "INVALID_ARGUMENT"
  | "INTERNAL_ERROR";

export class GatewayError extends Error {
  readonly code: GatewayErrorCode;
  readonly detail?: unknown;

  constructor(code: GatewayErrorCode, message: string, detail?: unknown) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

export function toControlError(requestId: string, err: unknown): UcpControlResponse {
  if (err instanceof GatewayError) {
    return errorResponse(requestId, err.message, err.code);
  }
  const message = err instanceof Error ? err.message : String(err);
  return errorResponse(requestId, message, "INTERNAL_ERROR");
}
