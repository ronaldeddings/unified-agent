import type { ProviderName } from "../session/types";
import type { PermissionMode } from "../providers/types";

export type ControlSubtype =
  | "initialize"
  | "can_use_tool"
  | "interrupt"
  | "set_permission_mode"
  | "set_model"
  | "set_max_thinking_tokens"
  | "mcp_status"
  | "mcp_message"
  | "mcp_set_servers"
  | "mcp_reconnect"
  | "mcp_toggle"
  | "rewind_files"
  | "hook_callback";

export interface InitializeControl {
  subtype: "initialize";
  provider: ProviderName;
  model?: string;
  gateway_session_id?: string;
  provider_session_id?: string;
}

export interface CanUseToolControl {
  subtype: "can_use_tool";
  tool_name: string;
  input: Record<string, unknown>;
  permission_suggestions?: unknown[];
  tool_use_id: string;
  description?: string;
  agent_id?: string;
}

export interface InterruptControl {
  subtype: "interrupt";
}

export interface SetPermissionModeControl {
  subtype: "set_permission_mode";
  mode: PermissionMode;
}

export interface SetModelControl {
  subtype: "set_model";
  model: string | "default";
}

export interface SetMaxThinkingTokensControl {
  subtype: "set_max_thinking_tokens";
  max_thinking_tokens: number | null;
}

export interface McpStatusControl {
  subtype: "mcp_status";
}

export interface McpMessageControl {
  subtype: "mcp_message";
  server_name: string;
  message: unknown;
}

export interface McpSetServersControl {
  subtype: "mcp_set_servers";
  servers: Record<string, unknown>;
}

export interface McpReconnectControl {
  subtype: "mcp_reconnect";
  serverName: string;
}

export interface McpToggleControl {
  subtype: "mcp_toggle";
  serverName: string;
  enabled: boolean;
}

export interface RewindFilesControl {
  subtype: "rewind_files";
  user_message_id: string;
  dry_run?: boolean;
}

export interface HookCallbackControl {
  subtype: "hook_callback";
  callback_id: string;
  input: unknown;
  tool_use_id?: string;
}

export type ControlRequestPayload =
  | InitializeControl
  | CanUseToolControl
  | InterruptControl
  | SetPermissionModeControl
  | SetModelControl
  | SetMaxThinkingTokensControl
  | McpStatusControl
  | McpMessageControl
  | McpSetServersControl
  | McpReconnectControl
  | McpToggleControl
  | RewindFilesControl
  | HookCallbackControl;

export interface UcpControlRequest {
  type: "control_request";
  request_id: string;
  request: ControlRequestPayload;
}

export interface UcpControlSuccess {
  subtype: "success";
  request_id: string;
  response?: unknown;
}

export interface UcpControlError {
  subtype: "error";
  request_id: string;
  error: string;
  code?: string;
}

export interface UcpControlResponse {
  type: "control_response";
  response: UcpControlSuccess | UcpControlError;
}

export interface UcpControlCancelRequest {
  type: "control_cancel_request";
  request_id: string;
}

export interface UcpUserMessage {
  type: "user";
  session_id: string;
  message: {
    role: "user";
    content: string;
  };
}

export interface UcpAssistantEvent {
  type: "assistant";
  session_id: string;
  event:
    | { subtype: "message"; text: string }
    | { subtype: "tool_progress"; name: string; details?: string }
    | { subtype: "tool_use_summary"; summary: string }
    | { subtype: "stream_event"; payload: unknown }
    | { subtype: "auth_status"; status: "ok" | "error"; detail?: string };
}

export interface UcpSystemEvent {
  type: "system";
  subtype: "init" | "status" | "warning";
  session_id: string;
  payload?: unknown;
}

export interface UcpTransportState {
  type: "transport_state";
  session_id: string;
  state: "cli_connected" | "cli_disconnected" | "reconnecting";
  payload?: unknown;
}

export interface UcpPermissionCancelled {
  type: "permission_cancelled";
  session_id: string;
  request_id: string;
  reason: string;
}

export interface UcpKeepAlive {
  type: "keep_alive";
  ts?: string;
}

export interface UcpEnvUpdate {
  type: "update_environment_variables";
  variables: Record<string, string>;
}

export interface UcpError {
  type: "error";
  code: string;
  message: string;
  request_id?: string;
  detail?: unknown;
}

export type UcpEnvelope =
  | UcpControlRequest
  | UcpControlResponse
  | UcpControlCancelRequest
  | UcpUserMessage
  | UcpAssistantEvent
  | UcpSystemEvent
  | UcpTransportState
  | UcpPermissionCancelled
  | UcpKeepAlive
  | UcpEnvUpdate
  | UcpError;

const CONTROL_SUBTYPES = new Set<ControlSubtype>([
  "initialize",
  "can_use_tool",
  "interrupt",
  "set_permission_mode",
  "set_model",
  "set_max_thinking_tokens",
  "mcp_status",
  "mcp_message",
  "mcp_set_servers",
  "mcp_reconnect",
  "mcp_toggle",
  "rewind_files",
  "hook_callback",
]);

const PROVIDERS = new Set<ProviderName>(["claude", "codex", "gemini", "mock"]);
const PERMISSION_MODES = new Set<PermissionMode>(["default", "acceptEdits", "plan", "bypassPermissions"]);

export function parseEnvelope(input: string | unknown): { ok: true; value: UcpEnvelope } | { ok: false; error: string } {
  const value = typeof input === "string" ? safeParse(input) : input;
  if (!value || typeof value !== "object") {
    return { ok: false, error: "envelope must be an object" };
  }
  const o = value as Record<string, unknown>;
  if (typeof o.type !== "string") {
    return { ok: false, error: "envelope.type must be a string" };
  }

  if (o.type === "control_request") {
    if (typeof o.request_id !== "string" || !o.request_id.trim()) {
      return { ok: false, error: "control_request.request_id is required" };
    }
    const req = o.request;
    if (!req || typeof req !== "object") {
      return { ok: false, error: "control_request.request is required" };
    }
    const subtype = (req as any).subtype;
    if (typeof subtype !== "string" || !CONTROL_SUBTYPES.has(subtype as ControlSubtype)) {
      return { ok: false, error: `unsupported control subtype: ${String(subtype)}` };
    }
    if (subtype === "initialize") {
      const provider = (req as any).provider;
      if (typeof provider !== "string" || !PROVIDERS.has(provider as ProviderName)) {
        return { ok: false, error: "initialize.provider must be claude|codex|gemini|mock" };
      }
    }
    if (subtype === "set_permission_mode") {
      const mode = (req as any).mode;
      if (typeof mode !== "string" || !PERMISSION_MODES.has(mode as PermissionMode)) {
        return { ok: false, error: "set_permission_mode.mode invalid" };
      }
    }
    if (subtype === "set_model") {
      const model = (req as any).model;
      if (typeof model !== "string" || !model.trim()) {
        return { ok: false, error: "set_model.model must be a non-empty string" };
      }
    }
    return { ok: true, value: o as UcpEnvelope };
  }

  if (o.type === "control_cancel_request") {
    if (typeof o.request_id !== "string" || !o.request_id.trim()) {
      return { ok: false, error: "control_cancel_request.request_id is required" };
    }
    return { ok: true, value: o as UcpEnvelope };
  }

  if (o.type === "user") {
    if (typeof o.session_id !== "string" || !o.session_id.trim()) {
      return { ok: false, error: "user.session_id is required" };
    }
    const message = o.message as Record<string, unknown>;
    if (!message || message.role !== "user" || typeof message.content !== "string") {
      return { ok: false, error: "user.message must include role=user and string content" };
    }
    return { ok: true, value: o as UcpEnvelope };
  }

  if (
    o.type === "control_response" ||
    o.type === "assistant" ||
    o.type === "system" ||
    o.type === "transport_state" ||
    o.type === "permission_cancelled" ||
    o.type === "keep_alive" ||
    o.type === "update_environment_variables" ||
    o.type === "error"
  ) {
    return { ok: true, value: o as UcpEnvelope };
  }

  return { ok: false, error: `unsupported envelope.type: ${o.type}` };
}

export function successResponse(requestId: string, response?: unknown): UcpControlResponse {
  return {
    type: "control_response",
    response: {
      subtype: "success",
      request_id: requestId,
      response,
    },
  };
}

export function errorResponse(requestId: string, error: string, code?: string): UcpControlResponse {
  return {
    type: "control_response",
    response: {
      subtype: "error",
      request_id: requestId,
      error,
      code,
    },
  };
}

function safeParse(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch {
    return null;
  }
}
