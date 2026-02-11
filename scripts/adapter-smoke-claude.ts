#!/usr/bin/env bun
import { ClaudeNativeAdapter } from "../src/adapters/claudeNative";

async function main(): Promise<void> {
  if (!Bun.which("claude")) {
    console.log(JSON.stringify({ skipped: true, reason: "claude not on PATH" }, null, 2));
    return;
  }

  const adapter = new ClaudeNativeAdapter();
  const ctx = {
    metaSessionId: "smoke-claude",
    gatewaySessionId: "gw-smoke-claude",
    project: "smoke",
    cwd: process.cwd(),
    provider: "claude" as const,
    permissionMode: "bypassPermissions" as const,
  };

  const init = await adapter.initialize(ctx);
  const result = await adapter.askUser({ ...ctx, providerSessionId: init.providerSessionId }, "Output exactly: CLAUDE_ADAPTER_SMOKE_OK");

  console.log(JSON.stringify({ init, text: result.text.slice(0, 400) }, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
