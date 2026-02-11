import { getProvider } from "../providers";
import type { PermissionMode } from "../providers/types";
import type { Adapter, AdapterSessionContext, AdapterTurnResult } from "./base";
import { runClaudeSdkRelayTurn } from "./claudeSdkDriver";

export class ClaudeNativeAdapter implements Adapter {
  readonly name = "claude" as const;
  readonly capabilities = {
    provider: "claude" as const,
    supportsSdkUrl: true,
    supportedControlSubtypes: new Set([
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
    ] as const),
  };

  async initialize(ctx: AdapterSessionContext): Promise<{ providerSessionId?: string; info?: unknown }> {
    return {
      providerSessionId: ctx.providerSessionId || `claude_${ctx.gatewaySessionId}`,
      info: { transport: ctx.brainUrl ? "sdk-url" : "local" },
    };
  }

  async askUser(ctx: AdapterSessionContext, text: string): Promise<AdapterTurnResult> {
    const provider = getProvider("claude");
    const providerSessionId = ctx.providerSessionId || `claude_${ctx.gatewaySessionId}`;
    if (!ctx.brainUrl) {
      const resp = await provider.ask(text, {
        cwd: ctx.cwd,
        model: ctx.model,
        brainSessionId: providerSessionId,
        permissionMode: ctx.permissionMode,
        maxThinkingTokens: ctx.maxThinkingTokens,
      });
      return { text: resp.text, providerSessionId, raw: resp.raw };
    }

    const timeoutMs = Number.parseInt(process.env.UNIFIED_AGENT_CLAUDE_SDK_TIMEOUT_MS || "45000", 10);
    try {
      const relay = await runClaudeSdkRelayTurn({
        sdkUrl: ctx.brainUrl,
        sessionId: providerSessionId,
        prompt: text,
        cwd: ctx.cwd,
        model: ctx.model,
        permissionMode: ctx.permissionMode,
        maxThinkingTokens: ctx.maxThinkingTokens,
        timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : 45000,
      });
      return {
        text: relay.text,
        providerSessionId,
        raw: relay.raw,
      };
    } catch (err) {
      if (process.env.UNIFIED_AGENT_CLAUDE_SDK_FALLBACK_LOCAL !== "1") {
        throw err;
      }
      const fallback = await provider.ask(text, {
        cwd: ctx.cwd,
        model: ctx.model,
        brainSessionId: providerSessionId,
        permissionMode: ctx.permissionMode,
        maxThinkingTokens: ctx.maxThinkingTokens,
      });
      return {
        text: fallback.text,
        providerSessionId,
        raw: {
          ...(fallback.raw as Record<string, unknown>),
          sdkUrlMode: "fallback-local",
          sdkUrlError: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }

  async setModel(_ctx: AdapterSessionContext, _model?: string): Promise<void> {
    // Model is applied on next call.
  }

  async setPermissionMode(_ctx: AdapterSessionContext, _mode: PermissionMode): Promise<void> {
    // Permission mode is applied on next call.
  }

  async setMaxThinkingTokens(_ctx: AdapterSessionContext, _maxThinkingTokens: number | null): Promise<void> {
    // Max thinking tokens are applied on next call.
  }

  async interrupt(_ctx: AdapterSessionContext): Promise<void> {
    // One-shot delegated mode has no stable interruption hook yet.
  }

  async mcpStatus(_ctx: AdapterSessionContext): Promise<unknown> {
    return { supported: true, transport: "delegated-cli" };
  }

  async mcpMessage(_ctx: AdapterSessionContext, serverName: string, message: unknown): Promise<unknown> {
    return { accepted: true, serverName, message };
  }

  async mcpSetServers(_ctx: AdapterSessionContext, servers: Record<string, unknown>): Promise<unknown> {
    return { accepted: true, serverCount: Object.keys(servers).length };
  }

  async mcpReconnect(_ctx: AdapterSessionContext, serverName: string): Promise<unknown> {
    return { accepted: true, serverName };
  }

  async mcpToggle(_ctx: AdapterSessionContext, serverName: string, enabled: boolean): Promise<unknown> {
    return { accepted: true, serverName, enabled };
  }

  async rewindFiles(_ctx: AdapterSessionContext, userMessageId: string, dryRun?: boolean): Promise<unknown> {
    return { accepted: true, userMessageId, dryRun: !!dryRun };
  }

  async hookCallback(_ctx: AdapterSessionContext, callbackId: string, input: unknown, toolUseId?: string): Promise<unknown> {
    return { accepted: true, callbackId, input, toolUseId };
  }
}
