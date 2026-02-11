import { createInterface } from "node:readline";
import { basename } from "node:path";
import { readFile } from "node:fs/promises";
import { SessionManager } from "./session/manager";
import { parseLine, type Command } from "./commands/parse";
import { getProvider } from "./providers";
import { getAdapter } from "./adapters";
import { ClaudeMemClient } from "./memory/claudeMemClient";
import type { ProviderName } from "./session/types";
import { redactForStorage } from "./util/redact";
import { newGatewaySessionId } from "./util/ids";
import { getJsonlPath } from "./storage/jsonl";
import { validateBrainUrl } from "./gateway/policy";

interface ContextConfig {
  mode: "off" | "recent" | "full";
  turns: number;
  maxChars: number;
  includeMemoryInject: boolean;
}

interface BrainState {
  connected: boolean;
  url?: string;
  provider?: ProviderName;
  sessionId?: string;
  remoteControlMode: boolean;
  initialized: boolean;
}

function parseBoolEnv(name: string, fallback: boolean): boolean {
  const v = (process.env[name] || "").trim().toLowerCase();
  if (!v) return fallback;
  if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  return fallback;
}

function resolveDefaultProvider(explicit?: ProviderName): ProviderName {
  if (explicit) return explicit;

  const envProvider = (process.env.UNIFIED_AGENT_DEFAULT_PROVIDER || "").trim().toLowerCase();
  const fromEnv =
    envProvider === "codex" || envProvider === "claude" || envProvider === "gemini" || envProvider === "mock"
      ? (envProvider as ProviderName)
      : null;

  const candidates: ProviderName[] = fromEnv
    ? [fromEnv, "codex", "claude", "gemini", "mock"]
    : ["codex", "claude", "gemini", "mock"];

  for (const p of candidates) {
    if (p === "mock") return p;
    if (typeof Bun !== "undefined" && Bun.which(p)) return p;
  }

  return "mock";
}

function resolveDefaultModel(explicit?: string): string | undefined {
  const direct = (explicit || "").trim();
  if (direct) return direct;
  const envModel = (process.env.UNIFIED_AGENT_DEFAULT_MODEL || "").trim();
  return envModel || undefined;
}

export interface RunReplOptions {
  initialPrompt?: string;
  once?: boolean;
  provider?: ProviderName;
  model?: string;
  brainUrl?: string;
  brainProvider?: ProviderName;
  brainSessionId?: string;
  remoteControlMode?: boolean;
  project?: string;
  cwd?: string;
  contextMode?: "off" | "recent" | "full";
  contextTurns?: number;
  contextChars?: number;
  includeMemoryInject?: boolean;
}

export async function runRepl(options: RunReplOptions = {}): Promise<void> {
  const sm = new SessionManager();
  const mem = new ClaudeMemClient();
  const contextCfg: ContextConfig = {
    mode: options.contextMode || "recent",
    turns: options.contextTurns || 12,
    maxChars: options.contextChars || Number.parseInt(process.env.UNIFIED_AGENT_CONTEXT_MAX_CHARS || "12000", 10),
    includeMemoryInject: options.includeMemoryInject ?? parseBoolEnv("UNIFIED_AGENT_MEM_DEFAULT", false),
  };

  const brain: BrainState = {
    connected: !!(options.brainUrl || "").trim(),
    url: (options.brainUrl || "").trim() || undefined,
    provider: options.brainProvider,
    sessionId: (options.brainSessionId || "").trim() || undefined,
    remoteControlMode: options.remoteControlMode ?? !!(options.brainUrl || "").trim(),
    initialized: false,
  };
  const brainModeEnabled = parseBoolEnv("UNIFIED_AGENT_ENABLE_BRAIN_GATEWAY", true);
  const canaryProviders = (process.env.UNIFIED_AGENT_BRAIN_CANARY_PROVIDERS || "claude,codex,gemini,mock")
    .split(",")
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
  const canaryAllowed = !brain.provider || canaryProviders.includes(brain.provider);
  if (!brainModeEnabled || !canaryAllowed) {
    brain.connected = false;
    brain.remoteControlMode = false;
    brain.url = undefined;
    brain.sessionId = undefined;
  }
  if (brain.url) {
    validateBrainUrl(brain.url, {});
  }

  const printHelp = () => {
    console.log("Commands:");
    console.log("  :help");
    console.log("  :provider claude|codex|gemini|mock");
    console.log("  :model <name|auto|default|off>");
    console.log("  :brain connect <ws(s)://url> [provider] [sessionId]");
    console.log("  :brain disconnect");
    console.log("  :brain status");
    console.log("  :brain replay <sessionId>");
    console.log("  :session new [projectName]");
    console.log("  :session list");
    console.log("  :session resume <metaSessionId>");
    console.log("  :context show");
    console.log("  :context mode off|recent|full");
    console.log("  :context turns <n>");
    console.log("  :context chars <n>");
    console.log("  :context mem on|off");
    console.log("  :mem inject");
    console.log("  :mem search <query>");
    console.log("  :mem stats");
    console.log("  :mem note <text>");
    console.log("  :quit");
  };

  const initialProvider = resolveDefaultProvider(options.provider || brain.provider);

  await sm.newSession({
    provider: initialProvider,
    model: resolveDefaultModel(options.model),
    project: options.project || basename(options.cwd || process.cwd()),
    cwd: options.cwd,
    brainUrl: brain.url,
    brainProvider: brain.provider,
    gatewaySessionId: brain.sessionId,
  });

  const ensureBrainInitialized = async () => {
    const s = sm.getCurrent();
    if (!s || !brain.connected) return;
    if (!brain.sessionId) {
      brain.sessionId = newGatewaySessionId();
    }
    await sm.setBrain({ url: brain.url, provider: brain.provider, gatewaySessionId: brain.sessionId });
    if (brain.provider && brain.provider !== s.activeProvider) {
      await sm.setProvider(brain.provider);
    }
    if (!brain.initialized) {
      await sm.recordControlRequest("initialize", {
        provider: brain.provider || s.activeProvider,
        model: s.activeModel,
        brainUrl: brain.url,
        gatewaySessionId: brain.sessionId,
      });
      await sm.recordControlResponse("success", { subtype: "initialize" });
      brain.initialized = true;
    }
  };

  const runUserMessage = async (userText: string): Promise<void> => {
    const s = sm.getCurrent();
    if (!s) throw new Error("no active meta-session");

    const redactedUser = redactForStorage(userText);
    const historyBlock = buildHistoryBlock(
      sm.getConversationHistory(contextCfg.mode === "full" ? 5000 : contextCfg.turns * 2),
      contextCfg.maxChars
    );

    let injected = "";
    if (contextCfg.includeMemoryInject && (await mem.health())) {
      const ctx = await mem.contextInject(s.project);
      if (ctx && ctx.trim()) {
        const maxChars = Number.parseInt(process.env.UNIFIED_AGENT_MEM_MAX_CHARS || "8000", 10);
        injected = ctx.trim().slice(0, Number.isFinite(maxChars) ? maxChars : 8000);
        await sm.recordMemoryInjected(injected);
      }
    }

    await sm.recordUser(redactedUser);

    const fullPrompt = buildProviderPrompt({
      injected,
      history: contextCfg.mode === "off" ? "" : historyBlock,
      userText,
    });

    if (brain.connected && brain.remoteControlMode) {
      await ensureBrainInitialized();
      const current = sm.getCurrent();
      if (!current) throw new Error("no active meta-session");

      const providerName = (brain.provider || current.activeProvider || "mock") as ProviderName;
      const adapter = getAdapter(providerName);

      const init = await adapter.initialize({
        metaSessionId: current.id,
        gatewaySessionId: brain.sessionId || newGatewaySessionId(),
        providerSessionId: current.providerSessionId,
        project: current.project,
        cwd: current.cwd,
        provider: providerName,
        model: current.activeModel,
        brainUrl: brain.url,
        permissionMode: "bypassPermissions",
      });

      if (init.providerSessionId) {
        await sm.setProviderSessionId(init.providerSessionId);
      }

      const response = await adapter.askUser(
        {
          metaSessionId: current.id,
          gatewaySessionId: brain.sessionId || newGatewaySessionId(),
          providerSessionId: current.providerSessionId || init.providerSessionId,
          project: current.project,
          cwd: current.cwd,
          provider: providerName,
          model: current.activeModel,
          brainUrl: brain.url,
          permissionMode: "bypassPermissions",
        },
        fullPrompt
      );

      if (response.providerSessionId) {
        await sm.setProviderSessionId(response.providerSessionId);
      }
      await sm.recordAssistant(redactForStorage(response.text));
      console.log(response.text);
      return;
    }

    const providerName = (s.activeProvider || "mock") as ProviderName;
    const provider = getProvider(providerName);

    const resp = await provider.ask(fullPrompt, {
      cwd: s.cwd,
      model: s.activeModel,
      permissionMode: "bypassPermissions",
    });
    await sm.recordAssistant(redactForStorage(resp.text));
    console.log(resp.text);
  };

  const runCommand = async (c: Command): Promise<"quit" | void> => {
    if (c.kind === "help") {
      printHelp();
    } else if (c.kind === "quit") {
      return "quit";
    } else if (c.kind === "provider") {
      await sm.setProvider(c.provider);
      if (brain.connected) brain.provider = c.provider;
    } else if (c.kind === "model") {
      await sm.setModel(c.model);
    } else if (c.kind === "brain_connect") {
      validateBrainUrl(c.url, {});
      brain.connected = true;
      brain.remoteControlMode = true;
      brain.url = c.url;
      brain.provider = c.provider || sm.getCurrent()?.activeProvider;
      brain.sessionId = c.sessionId || brain.sessionId || newGatewaySessionId();
      brain.initialized = false;
      await sm.setBrain({ url: brain.url, provider: brain.provider, gatewaySessionId: brain.sessionId });
      if (brain.provider) {
        await sm.setProvider(brain.provider);
      }
      console.log(`brain connected url=${brain.url} provider=${brain.provider || "(active)"} session=${brain.sessionId}`);
    } else if (c.kind === "brain_disconnect") {
      brain.connected = false;
      brain.initialized = false;
      await sm.setBrain({ url: undefined, provider: undefined, gatewaySessionId: undefined });
      console.log("brain disconnected");
    } else if (c.kind === "brain_status") {
      const s = sm.getCurrent();
      console.log(
        JSON.stringify(
          {
            connected: brain.connected,
            remoteControlMode: brain.remoteControlMode,
            url: brain.url,
            provider: brain.provider || s?.activeProvider,
            gatewaySessionId: brain.sessionId,
            providerSessionId: s?.providerSessionId,
          },
          null,
          2
        )
      );
    } else if (c.kind === "brain_replay") {
      const replay = await replaySession(c.sessionId);
      console.log(JSON.stringify(replay, null, 2));
    } else if (c.kind === "session_new") {
      const current = sm.getCurrent();
      await sm.newSession({
        project: c.project,
        provider: current?.activeProvider,
        model: current?.activeModel,
        brainUrl: current?.brainUrl,
        brainProvider: current?.brainProvider,
        gatewaySessionId: current?.gatewaySessionId,
        providerSessionId: current?.providerSessionId,
      });
      brain.initialized = false;
    } else if (c.kind === "session_list") {
      const sessions = sm.list(20);
      for (const s of sessions) {
        const model = s.activeModel || "provider-default";
        const brainInfo = s.brainUrl ? ` brain=${s.brainProvider || s.activeProvider}` : "";
        console.log(`${s.id}  provider=${s.activeProvider}  model=${model}  project=${s.project}  cwd=${s.cwd}${brainInfo}`);
      }
    } else if (c.kind === "session_resume") {
      const resumed = await sm.resume(c.id);
      brain.connected = !!resumed.brainUrl;
      brain.url = resumed.brainUrl;
      brain.provider = resumed.brainProvider;
      brain.sessionId = resumed.gatewaySessionId;
      brain.initialized = false;
    } else if (c.kind === "context_show") {
      console.log(JSON.stringify(contextCfg, null, 2));
    } else if (c.kind === "context_mode") {
      contextCfg.mode = c.mode;
    } else if (c.kind === "context_turns") {
      contextCfg.turns = c.turns;
    } else if (c.kind === "context_chars") {
      contextCfg.maxChars = c.chars;
    } else if (c.kind === "context_mem") {
      contextCfg.includeMemoryInject = c.enabled;
    } else if (c.kind === "mem_inject") {
      const s = sm.getCurrent();
      if (!s) throw new Error("no active meta-session");
      const ok = await mem.health();
      if (!ok) {
        console.log("claude-mem worker not reachable (expected at http://127.0.0.1:37777).");
      } else {
        const ctx = await mem.contextInject(s.project);
        console.log(ctx || "(no context)");
      }
    } else if (c.kind === "mem_search") {
      const s = sm.getCurrent();
      const project = s?.project;
      const ok = await mem.health();
      if (!ok) {
        console.log("claude-mem worker not reachable (expected at http://127.0.0.1:37777).");
      } else {
        const res = await mem.search(c.query, project);
        console.log(res.content.map((x) => x.text).join("\n"));
      }
    } else if (c.kind === "mem_stats") {
      const ok = await mem.health();
      if (!ok) {
        console.log("claude-mem worker not reachable (expected at http://127.0.0.1:37777).");
      } else {
        const stats = await mem.stats();
        console.log(stats ? JSON.stringify(stats, null, 2) : "(no stats)");
      }
    } else if (c.kind === "mem_note") {
      const s = sm.getCurrent();
      if (!s) throw new Error("no active meta-session");
      const ok = await mem.health();
      if (!ok) {
        console.log("claude-mem worker not reachable (expected at http://127.0.0.1:37777).");
      } else {
        const stored = await mem.storeObservation({
          contentSessionId: s.id,
          cwd: s.cwd,
          tool_name: "unified-agent.note",
          tool_input: { text: c.text },
          tool_response: { ok: true },
        });
        console.log(stored ? "stored" : "failed");
      }
    }
  };

  const runParsed = async (line: string): Promise<"quit" | void> => {
    const parsed = parseLine(line);
    if (parsed.command) {
      return runCommand(parsed.command);
    }
    if (parsed.userText) {
      await runUserMessage(parsed.userText);
    }
  };

  const initialPrompt = options.initialPrompt?.trim();
  if (initialPrompt) {
    try {
      await runParsed(initialPrompt);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      try {
        await sm.recordError(msg);
      } catch {
        // ignore
      }
      console.error(`error: ${msg}`);
    }
    if (options.once) {
      sm.close();
      return;
    }
  } else if (options.once) {
    sm.close();
    throw new Error("`--once` requires a prompt");
  }

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  const prompt = () => {
    const s = sm.getCurrent();
    const p = s?.activeProvider || "mock";
    const m = s?.activeModel || "default";
    const brainToken = brain.connected ? "|brain" : "";
    rl.setPrompt(`[${s?.id || "no-session"}|${p}|${m}${brainToken}]> `);
    rl.prompt();
  };

  rl.on("line", async (line) => {
    let shouldPrompt = true;
    try {
      const result = await runParsed(line);
      if (result === "quit") {
        shouldPrompt = false;
        rl.close();
        return;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      try {
        await sm.recordError(msg);
      } catch {
        // ignore
      }
      console.error(`error: ${msg}`);
    } finally {
      if (shouldPrompt) prompt();
    }
  });

  rl.on("close", () => {
    sm.close();
    process.exit(0);
  });

  printHelp();
  prompt();
}

function buildHistoryBlock(events: Array<{ type: string; text: string }>, maxChars: number): string {
  const lines = events.map((e) => {
    const role = e.type === "user_message" ? "User" : "Assistant";
    return `${role}: ${e.text}`;
  });

  let joined = lines.join("\n");
  if (joined.length <= maxChars) return joined;

  while (joined.length > maxChars && lines.length > 1) {
    lines.shift();
    joined = lines.join("\n");
  }
  return joined.slice(-maxChars);
}

function buildProviderPrompt(args: { injected: string; history: string; userText: string }): string {
  const parts: string[] = [];
  if (args.injected) {
    parts.push("=== MEMORY CONTEXT ===");
    parts.push(args.injected);
  }
  if (args.history) {
    parts.push("=== CONVERSATION HISTORY ===");
    parts.push(args.history);
  }
  parts.push("=== CURRENT USER MESSAGE ===");
  parts.push(args.userText);
  return parts.join("\n\n");
}

async function replaySession(metaSessionId: string): Promise<{
  metaSessionId: string;
  jsonlPath: string;
  totalEvents: number;
  eventTypeCounts: Record<string, number>;
  preview: Array<{ ts: string; provider: string; type: string; text: string }>;
}> {
  const path = getJsonlPath(metaSessionId);
  const content = await readFile(path, "utf-8");
  const rows = content
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { ts?: string; provider?: string; type?: string; text?: string });

  const eventTypeCounts: Record<string, number> = {};
  for (const row of rows) {
    const k = row.type || "unknown";
    eventTypeCounts[k] = (eventTypeCounts[k] || 0) + 1;
  }

  return {
    metaSessionId,
    jsonlPath: path,
    totalEvents: rows.length,
    eventTypeCounts,
    preview: rows.slice(0, 20).map((r) => ({
      ts: r.ts || "",
      provider: r.provider || "",
      type: r.type || "",
      text: (r.text || "").slice(0, 200),
    })),
  };
}
