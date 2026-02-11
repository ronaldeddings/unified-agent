#!/usr/bin/env bun
import { CodexCompatAdapter } from "../src/adapters/codexCompat";

async function main(): Promise<void> {
  if (!Bun.which("codex")) {
    console.log(JSON.stringify({ skipped: true, reason: "codex not on PATH" }, null, 2));
    return;
  }

  const adapter = new CodexCompatAdapter();
  const ctx = {
    metaSessionId: "smoke-codex",
    gatewaySessionId: "gw-smoke-codex",
    project: "smoke",
    cwd: process.cwd(),
    provider: "codex" as const,
    permissionMode: "bypassPermissions" as const,
  };

  const init = await adapter.initialize(ctx);
  const result = await adapter.askUser({ ...ctx, providerSessionId: init.providerSessionId }, "Output exactly: CODEX_ADAPTER_SMOKE_OK");

  console.log(JSON.stringify({ init, text: result.text.slice(0, 400) }, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
