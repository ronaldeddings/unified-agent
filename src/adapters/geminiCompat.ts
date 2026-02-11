import { getProvider } from "../providers";
import type { PermissionMode } from "../providers/types";
import type { Adapter, AdapterSessionContext, AdapterTurnResult } from "./base";

export class GeminiCompatAdapter implements Adapter {
  readonly name = "gemini" as const;
  readonly capabilities = {
    provider: "gemini" as const,
    supportsSdkUrl: false,
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
      providerSessionId: ctx.providerSessionId || `gemini_${ctx.gatewaySessionId}`,
      info: {
        transport: "compat-local-cli",
        note: "Gemini does not expose Claude-native sdk-url semantics in this integration",
      },
    };
  }

  async askUser(ctx: AdapterSessionContext, text: string): Promise<AdapterTurnResult> {
    const provider = getProvider("gemini");
    const started = Date.now();
    try {
      const resp = await provider.ask(text, {
        cwd: ctx.cwd,
        model: ctx.model,
        permissionMode: ctx.permissionMode,
        maxThinkingTokens: ctx.maxThinkingTokens,
        brainSessionId: ctx.providerSessionId,
      });
      return {
        text: resp.text,
        providerSessionId: ctx.providerSessionId || `gemini_${ctx.gatewaySessionId}`,
        raw: resp.raw,
      };
    } catch (err) {
      if (ctx.providerSessionId && Date.now() - started < 5_000) {
        const resp = await provider.ask(text, {
          cwd: ctx.cwd,
          model: ctx.model,
          permissionMode: ctx.permissionMode,
          maxThinkingTokens: ctx.maxThinkingTokens,
          brainSessionId: undefined,
        });
        return {
          text: resp.text,
          providerSessionId: `gemini_${ctx.gatewaySessionId}`,
          raw: { resumedFromStaleSession: true, error: err instanceof Error ? err.message : String(err), inner: resp.raw },
        };
      }
      throw err;
    }
  }

  async setModel(_ctx: AdapterSessionContext, _model?: string): Promise<void> {
    // Model is applied on next call.
  }

  async setPermissionMode(_ctx: AdapterSessionContext, _mode: PermissionMode): Promise<void> {
    // Permission mode is applied on next call.
  }

  async setMaxThinkingTokens(_ctx: AdapterSessionContext, _maxThinkingTokens: number | null): Promise<void> {
    // Not currently surfaced by gemini CLI call path.
  }

  async interrupt(_ctx: AdapterSessionContext): Promise<void> {
    // One-shot delegated mode has no stable interruption hook yet.
  }

  async mcpStatus(_ctx: AdapterSessionContext): Promise<unknown> {
    return {
      supported: "emulated",
      provider: "gemini",
      servers: [],
    };
  }

  async mcpMessage(_ctx: AdapterSessionContext, serverName: string, message: unknown): Promise<unknown> {
    return {
      supported: "emulated",
      provider: "gemini",
      serverName,
      accepted: true,
      message,
    };
  }

  async mcpSetServers(_ctx: AdapterSessionContext, servers: Record<string, unknown>): Promise<unknown> {
    return {
      supported: "emulated",
      provider: "gemini",
      configured: Object.keys(servers),
    };
  }

  async mcpReconnect(_ctx: AdapterSessionContext, serverName: string): Promise<unknown> {
    return {
      supported: "emulated",
      provider: "gemini",
      serverName,
      reconnected: true,
    };
  }

  async mcpToggle(_ctx: AdapterSessionContext, serverName: string, enabled: boolean): Promise<unknown> {
    return {
      supported: "emulated",
      provider: "gemini",
      serverName,
      enabled,
    };
  }

  async rewindFiles(_ctx: AdapterSessionContext, userMessageId: string, dryRun?: boolean): Promise<unknown> {
    return {
      supported: "emulated",
      provider: "gemini",
      userMessageId,
      dryRun: !!dryRun,
      rewound: !dryRun,
    };
  }

  async hookCallback(_ctx: AdapterSessionContext, callbackId: string, input: unknown, toolUseId?: string): Promise<unknown> {
    return {
      supported: "emulated",
      provider: "gemini",
      callbackId,
      input,
      toolUseId,
      accepted: true,
    };
  }
}
