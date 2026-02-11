import { getProvider } from "../providers";
import type { PermissionMode } from "../providers/types";
import type { Adapter, AdapterSessionContext, AdapterTurnResult } from "./base";

export class MockCompatAdapter implements Adapter {
  readonly name = "mock" as const;
  readonly capabilities = {
    provider: "mock" as const,
    supportsSdkUrl: false,
    supportedControlSubtypes: new Set([
      "initialize",
      "interrupt",
      "set_permission_mode",
      "set_model",
      "set_max_thinking_tokens",
      "can_use_tool",
    ] as const),
  };

  async initialize(ctx: AdapterSessionContext): Promise<{ providerSessionId?: string; info?: unknown }> {
    return {
      providerSessionId: ctx.providerSessionId || `mock_${ctx.gatewaySessionId}`,
      info: { transport: "in-process" },
    };
  }

  async askUser(ctx: AdapterSessionContext, text: string): Promise<AdapterTurnResult> {
    const provider = getProvider("mock");
    const resp = await provider.ask(text, {
      cwd: ctx.cwd,
      model: ctx.model,
      permissionMode: ctx.permissionMode,
    });
    return {
      text: resp.text,
      providerSessionId: ctx.providerSessionId || `mock_${ctx.gatewaySessionId}`,
      raw: resp.raw,
    };
  }

  async setModel(_ctx: AdapterSessionContext, _model?: string): Promise<void> {}
  async setPermissionMode(_ctx: AdapterSessionContext, _mode: PermissionMode): Promise<void> {}
  async setMaxThinkingTokens(_ctx: AdapterSessionContext, _maxThinkingTokens: number | null): Promise<void> {}
  async interrupt(_ctx: AdapterSessionContext): Promise<void> {}
}
