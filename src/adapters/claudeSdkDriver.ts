import { buildClaudeArgs } from "../providers/claudeCli";
import type { PermissionMode } from "../providers/types";
import { newRequestId } from "../util/ids";

export interface ClaudeSdkRelayOptions {
  sdkUrl: string;
  sessionId: string;
  prompt: string;
  cwd: string;
  model?: string;
  permissionMode: PermissionMode;
  maxThinkingTokens?: number;
  timeoutMs?: number;
}

export interface ClaudeSdkRelayResult {
  text: string;
  raw: Record<string, unknown>;
}

export async function runClaudeSdkRelayTurn(options: ClaudeSdkRelayOptions): Promise<ClaudeSdkRelayResult> {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Number(options.timeoutMs) : 45_000;
  const bodyUrl = buildSessionUrl(options.sdkUrl, options.sessionId);
  const relayUrl = buildSessionUrl(options.sdkUrl, options.sessionId, "relay");
  const debug = process.env.UNIFIED_AGENT_GATEWAY_DEBUG === "1";
  const trace = process.env.UNIFIED_AGENT_CLAUDE_SDK_TRACE === "1";

  const ws = new WebSocket(relayUrl);
  const wsReady = deferred<void>();
  const wsDone = deferred<void>();
  const result = deferred<{ text: string; envelope?: Record<string, unknown> }>();

  let lastAssistantText = "";
  let resolved = false;

  ws.addEventListener("open", () => {
    if (trace) console.log(`[claude-sdk-driver][${options.sessionId}] websocket open timeoutMs=${timeoutMs}`);
    wsReady.resolve();
  });

  ws.addEventListener("message", (event) => {
    const text = toText(event.data);
    if (!text) return;
    let envelope: any;
    try {
      envelope = JSON.parse(text);
    } catch {
      return;
    }
    if (debug) {
      console.log(`[claude-sdk-driver][${options.sessionId}] <= ${text.slice(0, 1200)}`);
    }

    if (envelope?.type === "control_request") {
      void respondToControlRequest(ws, envelope);
      return;
    }

    if (envelope?.type === "assistant") {
      const maybe = extractAssistantText(envelope);
      if (maybe) lastAssistantText = maybe;
      return;
    }

    if (envelope?.type === "result") {
      if (resolved) return;
      resolved = true;
      const textOut =
        typeof envelope?.result === "string" && envelope.result.trim()
          ? envelope.result.trim()
          : lastAssistantText || "";
      result.resolve({ text: textOut, envelope: envelope as Record<string, unknown> });
      return;
    }
  });

  ws.addEventListener("error", () => {
    if (resolved) return;
    result.reject(new Error("claude sdk relay websocket error"));
  });

  ws.addEventListener("close", () => {
    wsDone.resolve();
  });

  const args = buildClaudeArgs(" ", {
    model: options.model,
    sdkUrl: bodyUrl,
    permissionMode: options.permissionMode,
    maxThinkingTokens: options.maxThinkingTokens,
  });
  const proc = Bun.spawn({
    cmd: ["claude", ...args],
    cwd: options.cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });
  const stdoutPromise = new Response(proc.stdout).text();
  const stderrPromise = new Response(proc.stderr).text();

  void proc.exited.then((code) => {
    if (resolved) return;
    result.reject(new Error(`claude sdk process exited (${code}) before result`));
  });

  try {
    await waitFor(wsReady.promise, Math.min(timeoutMs, 12_000), "timed out opening relay websocket");
    if (trace) console.log(`[claude-sdk-driver][${options.sessionId}] writing stdin frames`);
    writeStdinFrames(proc, options);

    if (trace) console.log(`[claude-sdk-driver][${options.sessionId}] waiting for result`);
    const turn = await waitFor(result.promise, timeoutMs, `timed out waiting for Claude sdk result after ${timeoutMs}ms`);
    if (trace) console.log(`[claude-sdk-driver][${options.sessionId}] received result`);
    return {
      text: turn.text,
      raw: {
        sdkUrlMode: "native-relay",
        sessionId: options.sessionId,
        sdkUrl: bodyUrl,
        result: turn.envelope,
      },
    };
  } finally {
    if (trace) console.log(`[claude-sdk-driver][${options.sessionId}] shutdown`);
    safeCloseWebSocket(ws);
    await terminateProcess(proc);
    await Promise.race([wsDone.promise, sleep(300)]);
    // Prevent unhandled promise rejections from stream readers after forced shutdown.
    void stdoutPromise.catch(() => "");
    void stderrPromise.catch(() => "");
  }
}

async function respondToControlRequest(ws: WebSocket, envelope: any): Promise<void> {
  const reqId = envelope?.request_id;
  const subtype = envelope?.request?.subtype;
  if (typeof reqId !== "string" || typeof subtype !== "string") return;

  let response: Record<string, unknown> = {};
  if (subtype === "can_use_tool") {
    response = {
      behavior: "allow",
      updatedInput: envelope?.request?.input || {},
    };
  } else if (subtype === "mcp_message") {
    response = { mcp_response: null };
  } else if (subtype === "mcp_status") {
    response = { mcpServers: [] };
  }

  ws.send(
    JSON.stringify({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: reqId,
        response,
      },
    })
  );
}

function writeStdinFrames(proc: Bun.Subprocess<"pipe", "pipe", "pipe">, options: ClaudeSdkRelayOptions): void {
  const frames: string[] = [];
  frames.push(
    JSON.stringify({
      type: "control_request",
      request_id: newRequestId(),
      request: { subtype: "initialize" },
    })
  );
  frames.push(
    JSON.stringify({
      type: "control_request",
      request_id: newRequestId(),
      request: { subtype: "set_permission_mode", mode: options.permissionMode },
    })
  );
  if (options.model) {
    frames.push(
      JSON.stringify({
        type: "control_request",
        request_id: newRequestId(),
        request: { subtype: "set_model", model: options.model },
      })
    );
  }
  if (options.maxThinkingTokens !== undefined && options.maxThinkingTokens !== null) {
    frames.push(
      JSON.stringify({
        type: "control_request",
        request_id: newRequestId(),
        request: {
          subtype: "set_max_thinking_tokens",
          max_thinking_tokens: options.maxThinkingTokens,
        },
      })
    );
  }
  frames.push(
    JSON.stringify({
      type: "user",
      session_id: options.sessionId,
      message: {
        role: "user",
        content: options.prompt,
      },
    })
  );

  proc.stdin.write(`${frames.join("\n")}\n`);
  proc.stdin.end();
}

function extractAssistantText(envelope: any): string {
  if (typeof envelope?.event?.subtype === "string" && envelope.event.subtype === "message") {
    const t = envelope?.event?.text;
    return typeof t === "string" ? t.trim() : "";
  }
  const blocks = envelope?.message?.content;
  if (!Array.isArray(blocks)) return "";
  const texts = blocks
    .filter((b: any) => b?.type === "text" && typeof b.text === "string")
    .map((b: any) => String(b.text).trim())
    .filter(Boolean);
  return texts.join("\n").trim();
}

function buildSessionUrl(base: string, sessionId: string, role?: string): string {
  const u = new URL(base);
  u.searchParams.set("sessionId", sessionId);
  if (role) u.searchParams.set("role", role);
  return u.toString();
}

function toText(data: unknown): string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(new Uint8Array(data));
  }
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  }
  return "";
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor<T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function safeCloseWebSocket(ws: WebSocket): void {
  try {
    ws.close();
  } catch {
    // ignore
  }
}

async function terminateProcess(proc: Bun.Subprocess<"pipe", "pipe", "pipe">): Promise<void> {
  try {
    proc.kill("SIGTERM");
  } catch {
    // ignore
  }
  await Promise.race([proc.exited, sleep(1200)]);
  if (!proc.killed) {
    try {
      proc.kill("SIGKILL");
    } catch {
      // ignore
    }
    await Promise.race([proc.exited, sleep(600)]);
  }
}
