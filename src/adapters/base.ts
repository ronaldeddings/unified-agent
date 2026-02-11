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

export interface AdapterCapabilities {
  provider: ProviderName;
  supportsSdkUrl: boolean;
  supportedControlSubtypes: Set<ControlSubtype>;
}

export interface AdapterSessionContext {
  metaSessionId: string;
  gatewaySessionId: string;
  providerSessionId?: string;
  project: string;
  cwd: string;
  provider: ProviderName;
  model?: string;
  brainUrl?: string;
  permissionMode: PermissionMode;
  maxThinkingTokens?: number;
}

export interface AdapterTurnResult {
  text: string;
  providerSessionId?: string;
  raw?: unknown;
}

export interface Adapter {
  readonly name: ProviderName;
  readonly capabilities: AdapterCapabilities;

  initialize(ctx: AdapterSessionContext): Promise<{ providerSessionId?: string; info?: unknown }>;
  askUser(ctx: AdapterSessionContext, text: string): Promise<AdapterTurnResult>;

  setModel?(ctx: AdapterSessionContext, model?: string): Promise<void>;
  setPermissionMode?(ctx: AdapterSessionContext, mode: PermissionMode): Promise<void>;
  setMaxThinkingTokens?(ctx: AdapterSessionContext, maxThinkingTokens: number | null): Promise<void>;
  interrupt?(ctx: AdapterSessionContext): Promise<void>;

  mcpStatus?(ctx: AdapterSessionContext): Promise<unknown>;
  mcpMessage?(ctx: AdapterSessionContext, serverName: string, message: unknown): Promise<unknown>;
  mcpSetServers?(ctx: AdapterSessionContext, servers: Record<string, unknown>): Promise<unknown>;
  mcpReconnect?(ctx: AdapterSessionContext, serverName: string): Promise<unknown>;
  mcpToggle?(ctx: AdapterSessionContext, serverName: string, enabled: boolean): Promise<unknown>;
  rewindFiles?(ctx: AdapterSessionContext, userMessageId: string, dryRun?: boolean): Promise<unknown>;
  hookCallback?(ctx: AdapterSessionContext, callbackId: string, input: unknown, toolUseId?: string): Promise<unknown>;
}

export function hasSubtype(capabilities: AdapterCapabilities, subtype: ControlSubtype): boolean {
  return capabilities.supportedControlSubtypes.has(subtype);
}
