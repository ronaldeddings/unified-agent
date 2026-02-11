#!/usr/bin/env bun
import { GatewayRouter } from "../src/gateway/router";

async function main(): Promise<void> {
  const router = new GatewayRouter();

  const sessionId = "smoke-session";

  const init = await router.handleEnvelope(sessionId, {
    type: "control_request",
    request_id: "req_init",
    request: {
      subtype: "initialize",
      provider: "mock",
      model: "default",
    },
  });

  const user = await router.handleEnvelope(sessionId, {
    type: "user",
    session_id: sessionId,
    message: {
      role: "user",
      content: "Output exactly: GATEWAY_SMOKE_OK",
    },
  });

  console.log(
    JSON.stringify(
      {
        init,
        user,
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
