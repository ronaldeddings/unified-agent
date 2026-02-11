#!/usr/bin/env bun
import { BrainGatewayServer } from "../src/gateway/wsServer";

const port = Number.parseInt(process.env.UNIFIED_AGENT_GATEWAY_PORT || "7799", 10);
const host = process.env.UNIFIED_AGENT_GATEWAY_HOST || "127.0.0.1";

const server = new BrainGatewayServer();
const started = server.start({ host, port });
console.log(JSON.stringify({ ok: true, url: started.url }, null, 2));

const shutdown = () => {
  server.stop(true);
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

setInterval(() => {
  // keep process alive
}, 60_000);
