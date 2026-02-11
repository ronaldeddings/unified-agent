import { randomUUID } from "node:crypto";
import { buildHydrationPayload } from "./hydration";
import { HeartbeatMonitor } from "./heartbeat";
import { GatewayRouter, type GatewayRouterOptions } from "./router";
import { RelaunchWatchdog } from "./watchdog";
import { OtlpMetricsExporter } from "./otlp";
import { EnvProfileStore } from "./envProfiles";

export interface GatewayServerStartOptions {
  port?: number;
  host?: string;
}

interface SocketData {
  sessionId: string;
  role?: string;
}

export class BrainGatewayServer {
  readonly router: GatewayRouter;
  private server?: ReturnType<typeof Bun.serve<SocketData>>;
  private readonly peersBySession = new Map<string, Set<ServerWebSocket<SocketData>>>();
  private readonly heartbeat: HeartbeatMonitor;
  private readonly watchdog: RelaunchWatchdog;
  private readonly otlpExporter?: OtlpMetricsExporter;
  private readonly envProfiles: EnvProfileStore;

  constructor(options: GatewayRouterOptions = {}) {
    this.router = new GatewayRouter(options);
    this.heartbeat = new HeartbeatMonitor(this.router.registry, {
      onStale: (sessionId) => {
        const state = this.router.registry.get(sessionId);
        if (!state) return;
        state.connected = false;
        state.lastSeenEpoch = Date.now();
        this.watchdog.schedule(sessionId);
      },
    });
    this.watchdog = new RelaunchWatchdog(this.router.registry, {
      onRelaunch: async (sessionId) => {
        const state = this.router.registry.get(sessionId);
        if (!state) return;
        state.replay.push({
          type: "system",
          subtype: "warning",
          session_id: sessionId,
          payload: {
            relaunch: "required",
            reason: "stale session heartbeat timeout",
          },
        });
      },
    });
    const otlpEndpoint = (process.env.UNIFIED_AGENT_OTLP_ENDPOINT || "").trim();
    if (otlpEndpoint) {
      this.otlpExporter = new OtlpMetricsExporter(this.router.getMetricsInstance(), {
        endpoint: otlpEndpoint,
        intervalMs: Number.parseInt(process.env.UNIFIED_AGENT_OTLP_INTERVAL_MS || "15000", 10),
      });
    }
    this.envProfiles = new EnvProfileStore();
  }

  start(options: GatewayServerStartOptions = {}): { url: string } {
    if (typeof Bun === "undefined" || !Bun.serve) {
      throw new Error("BrainGatewayServer requires Bun runtime");
    }

    this.server = Bun.serve<SocketData>({
      hostname: options.host || "127.0.0.1",
      port: options.port || 0,
      fetch: async (req, server) => {
        const url = new URL(req.url);

        if (req.method === "GET" && url.pathname === "/health") {
          return Response.json({
            ok: true,
            sessions: this.router.registry.list().length,
            metrics: this.router.getMetricsSnapshot(),
          });
        }
        if (req.method === "GET" && url.pathname === "/models") {
          return Response.json({
            providers: {
              claude: ["provider-default"],
              codex: ["provider-default"],
              gemini: ["provider-default"],
              mock: ["provider-default"],
            },
          });
        }
        if (req.method === "GET" && url.pathname === "/usage") {
          return Response.json({
            metrics: this.router.getMetricsSnapshot(),
            sessions: this.router.registry.list().map((s) => ({
              sessionId: s.sessionId,
              provider: s.provider,
              pendingRequests: s.pendingRequests.size,
              pendingPermissions: s.pendingPermissions.listBySession(s.sessionId).length,
            })),
          });
        }
        if (req.method === "GET" && url.pathname === "/metrics") {
          return new Response(this.router.getMetricsPrometheus(), {
            headers: {
              "content-type": "text/plain; version=0.0.4; charset=utf-8",
            },
          });
        }
        if (req.method === "GET" && url.pathname === "/env/profiles") {
          return Response.json({ profiles: this.envProfiles.list() });
        }
        if (req.method === "PUT" && url.pathname.startsWith("/env/profiles/")) {
          const name = decodeURIComponent(url.pathname.slice("/env/profiles/".length)).trim();
          if (!name) return Response.json({ error: "profile name required" }, { status: 400 });
          const body = await safeJson(req);
          const vars = normalizeVariables((body as any)?.variables ?? body);
          this.envProfiles.put(name, vars);
          return Response.json({ ok: true, name, variables: vars });
        }
        if (req.method === "DELETE" && url.pathname.startsWith("/env/profiles/")) {
          const name = decodeURIComponent(url.pathname.slice("/env/profiles/".length)).trim();
          if (!name) return Response.json({ error: "profile name required" }, { status: 400 });
          const removed = this.envProfiles.delete(name);
          return Response.json({ ok: removed, name });
        }
        if (req.method === "POST" && url.pathname.startsWith("/env/session/")) {
          const parts = url.pathname.split("/").filter(Boolean);
          // /env/session/:sessionId/profile/:name
          if (parts.length === 5 && parts[0] === "env" && parts[1] === "session" && parts[3] === "profile") {
            const sessionId = decodeURIComponent(parts[2]);
            const profileName = decodeURIComponent(parts[4]);
            const vars = this.envProfiles.get(profileName);
            if (!vars) return Response.json({ error: "profile not found" }, { status: 404 });
            const count = this.router.applyEnvironmentVariables(sessionId, vars);
            return Response.json({ ok: true, sessionId, profileName, applied: count });
          }
        }

        const sid = (url.searchParams.get("sessionId") || "").trim();
        const role = (url.searchParams.get("role") || "").trim().toLowerCase() || undefined;
        const sessionId = sid || randomUUID();
        if (url.pathname === "/ws" && server.upgrade(req, { data: { sessionId, role } })) {
          return new Response(null, { status: 101 });
        }
        return new Response("not found", { status: 404 });
      },
      websocket: {
        open: (ws) => {
          const sessionId = ws.data.sessionId;
          this.addPeer(ws);
          const state = this.router.registry.get(sessionId);
          ws.send(
            JSON.stringify({
              type: "transport_state",
              session_id: sessionId,
              state: "cli_connected",
            })
          );
          this.broadcastEnvelope(sessionId, ws, {
            type: "transport_state",
            session_id: sessionId,
            state: "cli_connected",
          });
          if (!state) return;
          this.router.markSessionConnected(sessionId);
          this.watchdog.clear(sessionId);
          void this.router.flushOutbound(sessionId, (event) => {
            ws.send(JSON.stringify(event));
          });
          for (const event of buildHydrationPayload(state)) {
            ws.send(JSON.stringify(event));
          }
        },
        message: async (ws, message) => {
          const sessionId = ws.data.sessionId;
          const raw = typeof message === "string" ? message : Buffer.from(message).toString("utf-8");
          if (process.env.UNIFIED_AGENT_GATEWAY_DEBUG === "1") {
            console.log(`[gateway][${sessionId}] <= ${raw.slice(0, 1200)}`);
          }
          this.broadcastRaw(sessionId, ws, raw);

          if (ws.data.role === "relay") {
            return;
          }

          const responses = await this.router.handleRaw(sessionId, raw);
          for (let i = 0; i < responses.length; i += 1) {
            const response = responses[i];
            const id = `${Date.now()}_${i}_${Math.random().toString(16).slice(2)}`;
            try {
              if (process.env.UNIFIED_AGENT_GATEWAY_DEBUG === "1") {
                console.log(`[gateway][${sessionId}] => ${JSON.stringify(response).slice(0, 1200)}`);
              }
              ws.send(JSON.stringify(response));
            } catch {
              this.router.enqueueOutbound(sessionId, id, response);
            }
          }
        },
        close: (ws) => {
          const sessionId = ws.data.sessionId;
          this.removePeer(ws);
          if (this.peerCount(sessionId) > 0) {
            return;
          }
          const events = this.router.markSessionDisconnected(sessionId, "backend disconnected");
          this.watchdog.schedule(sessionId);
          if (events.length > 0) {
            // Events are persisted in router state; client is already disconnected.
          }
        },
      },
    });

    this.heartbeat.start();
    this.otlpExporter?.start();

    const host = this.server.hostname || "127.0.0.1";
    return { url: `ws://${host}:${this.server.port}` };
  }

  stop(closeActiveConnections = true): void {
    if (!this.server) return;
    this.heartbeat.stop();
    this.watchdog.clearAll();
    this.otlpExporter?.stop();
    this.server.stop(closeActiveConnections);
    this.server = undefined;
  }

  private addPeer(ws: ServerWebSocket<SocketData>): void {
    const sessionId = ws.data.sessionId;
    const peers = this.peersBySession.get(sessionId) || new Set<ServerWebSocket<SocketData>>();
    peers.add(ws);
    this.peersBySession.set(sessionId, peers);
  }

  private removePeer(ws: ServerWebSocket<SocketData>): void {
    const sessionId = ws.data.sessionId;
    const peers = this.peersBySession.get(sessionId);
    if (!peers) return;
    peers.delete(ws);
    if (peers.size === 0) {
      this.peersBySession.delete(sessionId);
    }
  }

  private peerCount(sessionId: string): number {
    return this.peersBySession.get(sessionId)?.size || 0;
  }

  private broadcastRaw(sessionId: string, sender: ServerWebSocket<SocketData>, raw: string): void {
    const peers = this.peersBySession.get(sessionId);
    if (!peers || peers.size < 2) return;
    for (const peer of peers) {
      if (peer === sender) continue;
      try {
        peer.send(raw);
      } catch {
        // Ignore peer send failures; disconnect handling will clean up.
      }
    }
  }

  private broadcastEnvelope(sessionId: string, sender: ServerWebSocket<SocketData>, envelope: unknown): void {
    let raw = "";
    try {
      raw = JSON.stringify(envelope);
    } catch {
      return;
    }
    this.broadcastRaw(sessionId, sender, raw);
  }
}

async function safeJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return {};
  }
}

function normalizeVariables(input: unknown): Record<string, string> {
  if (!input || typeof input !== "object") return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (!k) continue;
    out[k] = String(v ?? "");
  }
  return out;
}
