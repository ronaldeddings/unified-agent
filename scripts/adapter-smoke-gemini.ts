#!/usr/bin/env bun
import { GeminiCompatAdapter } from "../src/adapters/geminiCompat";

async function main(): Promise<void> {
  if (!Bun.which("gemini")) {
    console.log(JSON.stringify({ skipped: true, reason: "gemini not on PATH" }, null, 2));
    return;
  }

  const adapter = new GeminiCompatAdapter();
  const ctx = {
    metaSessionId: "smoke-gemini",
    gatewaySessionId: "gw-smoke-gemini",
    project: "smoke",
    cwd: process.cwd(),
    provider: "gemini" as const,
    permissionMode: "bypassPermissions" as const,
  };

  const init = await adapter.initialize(ctx);
  const result = await adapter.askUser({ ...ctx, providerSessionId: init.providerSessionId }, "Output exactly: GEMINI_ADAPTER_SMOKE_OK");

  console.log(JSON.stringify({ init, text: result.text.slice(0, 400) }, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
