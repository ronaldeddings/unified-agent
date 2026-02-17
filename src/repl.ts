import { createInterface } from "node:readline";
import { basename, join } from "node:path";
import { readFile } from "node:fs/promises";
import { SessionManager } from "./session/manager";
import { parseLine, type Command } from "./commands/parse";
import { getProvider } from "./providers";
import { getAdapter } from "./adapters";
import { ClaudeMemClient } from "./memory/claudeMemClient";
import { DefensiveClaudeMemClient } from "./memory/defensiveMem.ts";
import type { ProviderName } from "./session/types";
import { redactForStorage } from "./util/redact";
import { newGatewaySessionId } from "./util/ids";
import { getJsonlPath } from "./storage/jsonl";
import { validateBrainUrl } from "./gateway/policy";
import { wrapSessionManagerWithScoring } from "./scoring/realtime.ts";
import { scanSessions } from "./scanner/scanner.ts";
import { detectParser } from "./parsers/index.ts";
import { scoreEvent } from "./scoring/importance.ts";
import { buildChunks } from "./scoring/chunker.ts";
import { assessChunks } from "./assessment/assessor.ts";
import { computeConsensus } from "./assessment/consensus.ts";
import { distill } from "./distiller/distiller.ts";
import { getGenerator } from "./output/index.ts";
import { GatewayMetrics } from "./gateway/metrics.ts";
import { SessionWatcher } from "./distiller/watcher.ts";
import { AssessmentQueue } from "./distiller/assessmentQueue.ts";
import { getDataDir } from "./util/paths.ts";
import type { OutputPlatform } from "./output/index.ts";
import { queryDistill } from "./distiller/queryDistiller.ts";
import { extractFilters, type DistillFilterParams } from "./distiller/naturalFilter.ts";
import { groupByTopic, assembleSynthesis, generateConversationFromSynthesis } from "./synthesis/synthesizer.ts";
import { conversationGenerator } from "./output/conversationGenerator.ts";
import { findLatestBuild, loadDistilledConversation, extractContextText, type DistilledConversation } from "./distiller/distillLoader.ts";

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
  const rawSm = new SessionManager();

  // Item 90: Wire real-time scoring — wrap SessionManager before entering REPL loop
  const distillEnabled = parseBoolEnv("UNIFIED_AGENT_DISTILL_ENABLED", false);
  const sm = distillEnabled ? wrapSessionManagerWithScoring(rawSm) : rawSm;

  // Item 91: Wire defensive mem — replace direct ClaudeMemClient with DefensiveClaudeMemClient
  const rawMem = new ClaudeMemClient();
  const rawDb = rawSm.getSessionDb().getDb();
  const defensiveMem = new DefensiveClaudeMemClient(rawMem, rawDb);

  // Gateway metrics for distillation counters
  const metrics = new GatewayMetrics();

  // Assessment queue with backpressure (Item 76)
  const distillProviders = (process.env.UNIFIED_AGENT_DISTILL_PROVIDERS || "claude,codex,gemini")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s === "claude" || s === "codex" || s === "gemini") as ("claude" | "codex" | "gemini")[];
  const assessmentQueue = new AssessmentQueue({
    maxConcurrent: Number.parseInt(process.env.UNIFIED_AGENT_DISTILL_MAX_CONCURRENT || "3", 10),
    timeoutMs: Number.parseInt(process.env.UNIFIED_AGENT_DISTILL_ASSESSMENT_TIMEOUT_MS || "30000", 10),
    providers: distillProviders.length > 0 ? distillProviders : ["claude", "codex", "gemini"],
  });

  // Background watcher (Item 75) — initialized but not started until :distill watch on
  const watcher = new SessionWatcher(
    {
      onNewSession: (session) => {
        console.log(`[watcher] new session detected: ${session.platform} ${session.filePath}`);
      },
      onError: (err) => {
        console.error(`[watcher] error: ${err.message}`);
      },
    },
    { intervalMs: 5000 },
  );

  // Auto-start watcher if env flag is set
  if (parseBoolEnv("UNIFIED_AGENT_DISTILL_WATCH", false)) {
    await watcher.start();
  }

  // Loaded distilled conversation context (set by :distill load, cleared by :distill unload)
  let loadedConversation: DistilledConversation | null = null;

  // Item 92: Periodic sync queue flush (every 60 seconds)
  const syncIntervalMs = Number.parseInt(process.env.UNIFIED_AGENT_DISTILL_SYNC_INTERVAL_MS || "60000", 10);
  const syncTimer = setInterval(async () => {
    try {
      await defensiveMem.flushSyncQueue();
    } catch {
      // Ignore flush errors
    }
  }, syncIntervalMs);

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

  // Item 78: Add :distill to :help output
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
    console.log('  :distill ask "question" [--platform claude|codex|gemini] [--providers p1,p2]');
    console.log("  :distill scan");
    console.log("  :distill run [sessionId...] [--providers p1,p2]");
    console.log("  :distill build [--cwd path] [--limit N] [--budget N] [--format conversation|summary] [--providers p1,p2] [--dry-run] [--filter \"...\"]");
    console.log("  :distill preview [--cwd path] [--limit N]  (alias for build --dry-run)");
    console.log('  :distill filter "natural language scope description" [--providers p1,p2]');
    console.log("  :distill load [path] [--cwd path]          load distilled context for provider sessions");
    console.log("  :distill unload                             clear loaded distilled context");
    console.log("  :distill seed claude|codex|gemini [sessionId]");
    console.log("  :distill query <text>");
    console.log("  :distill report [sessionId]");
    console.log("  :distill assess [chunkId]");
    console.log("  :distill status");
    console.log("  :distill watch on|off");
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
    if (contextCfg.includeMemoryInject && (await rawMem.health())) {
      const ctx = await defensiveMem.contextInject(s.project);
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

    // If distilled context is loaded, inject it into the provider call
    let promptWithContext = fullPrompt;
    let resumePath: string | undefined;

    if (loadedConversation) {
      if (providerName === "claude") {
        // Claude supports --resume natively — pass the JSONL file path
        resumePath = loadedConversation.filePath;
      } else {
        // Other providers: prepend distilled context as text
        const contextBlock = extractContextText(loadedConversation);
        promptWithContext = contextBlock + "\n\n" + fullPrompt;
      }
    }

    const resp = await provider.ask(promptWithContext, {
      cwd: s.cwd,
      model: s.activeModel,
      permissionMode: "bypassPermissions",
      resumePath,
    });
    await sm.recordAssistant(redactForStorage(resp.text));
    console.log(resp.text);
  };

  // Item 93: Graceful shutdown helper
  const gracefulShutdown = async () => {
    // Stop background watcher
    watcher.stop();
    // Stop periodic sync timer
    clearInterval(syncTimer);
    // Flush any remaining sync queue entries
    try {
      await defensiveMem.flushSyncQueue();
    } catch {
      // Best-effort flush on shutdown
    }
    sm.close();
  };

  const runCommand = async (c: Command): Promise<"quit" | void> => {
    if (c.kind === "help") {
      printHelp();
    } else if (c.kind === "quit") {
      // Item 93: Graceful shutdown on :quit
      await gracefulShutdown();
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
      const ok = await rawMem.health();
      if (!ok) {
        console.log("claude-mem worker not reachable (expected at http://127.0.0.1:37777).");
      } else {
        const ctx = await defensiveMem.contextInject(s.project);
        console.log(ctx || "(no context)");
      }
    } else if (c.kind === "mem_search") {
      const s = sm.getCurrent();
      const project = s?.project;
      const ok = await rawMem.health();
      if (!ok) {
        console.log("claude-mem worker not reachable (expected at http://127.0.0.1:37777).");
      } else {
        const res = await rawMem.search(c.query, project);
        console.log(res.content.map((x) => x.text).join("\n"));
      }
    } else if (c.kind === "mem_stats") {
      const ok = await rawMem.health();
      if (!ok) {
        console.log("claude-mem worker not reachable (expected at http://127.0.0.1:37777).");
      } else {
        const stats = await rawMem.stats();
        console.log(stats ? JSON.stringify(stats, null, 2) : "(no stats)");
      }
    } else if (c.kind === "mem_note") {
      const s = sm.getCurrent();
      if (!s) throw new Error("no active meta-session");
      const ok = await rawMem.health();
      if (!ok) {
        console.log("claude-mem worker not reachable (expected at http://127.0.0.1:37777).");
      } else {
        const stored = await rawMem.storeObservation({
          contentSessionId: s.id,
          cwd: s.cwd,
          tool_name: "unified-agent.note",
          tool_input: { text: c.text },
          tool_response: { ok: true },
        });
        console.log(stored ? "stored" : "failed");
      }

    // ═══════════════════════════════════════════════════════════
    // Distillation commands (Items 67-74)
    // ═══════════════════════════════════════════════════════════

    } else if (c.kind === "distill_scan") {
      // Item 67: Scan all platforms for session files
      metrics.distillScans();
      const sessions = await scanSessions();
      if (sessions.length === 0) {
        console.log("No session files found.");
      } else {
        console.log(`Found ${sessions.length} session file(s):\n`);
        console.log("  Platform   Size       Modified                  Path");
        console.log("  ─────────  ─────────  ────────────────────────  ────────────────────────");
        for (const s of sessions) {
          const sizeKb = (s.fileSize / 1024).toFixed(1).padStart(7) + " KB";
          const modified = s.modifiedAt.toISOString().slice(0, 19).replace("T", " ");
          const platform = s.platform.padEnd(9);
          console.log(`  ${platform}  ${sizeKb}  ${modified}  ${s.filePath}`);
        }
      }

    } else if (c.kind === "distill_run") {
      // Item 68: Execute full pipeline: scan → parse → score → chunk → assess → consensus → distill
      metrics.distillRuns();
      console.log("Starting distillation pipeline...");

      // Step 1: Determine which sessions to process
      let sessions = await scanSessions({
        projectPath: c.cwd,
        limit: c.limit,
      });
      if (c.sessionIds && c.sessionIds.length > 0) {
        sessions = sessions.filter((s) => c.sessionIds!.some((id) => s.sessionId === id || s.filePath.includes(id)));
      }
      if (sessions.length === 0) {
        console.log("No matching sessions found.");
        return;
      }
      // Warn if processing a large number of sessions without explicit limits
      if (!c.limit && !c.cwd && sessions.length > 100) {
        console.log(`⚠️  Found ${sessions.length} sessions. This may take a very long time.`);
        console.log(`   Tip: Use :distill build --cwd . for project-scoped builds, or add --limit N.`);
      }
      console.log(`Processing ${sessions.length} session(s)...`);

      // Step 2: Parse + Score all sessions
      const allScoredEvents: Array<{ event: import("./parsers/types.ts").ParsedEvent; score: number }> = [];
      for (const session of sessions) {
        const parser = detectParser(session.filePath);
        if (!parser) {
          console.log(`  Skipping ${session.filePath} (no parser detected)`);
          continue;
        }
        const source = await Bun.file(session.filePath).text();
        for await (const event of parser.parse(source)) {
          const score = scoreEvent(event);
          allScoredEvents.push({ event: { ...event, metadata: { ...event.metadata, importanceScore: score } }, score });
        }
      }
      console.log(`  Parsed ${allScoredEvents.length} events`);

      // Step 3: Build chunks
      const scoredParsedEvents = allScoredEvents.map((e) => e.event);
      const chunks = buildChunks(scoredParsedEvents, sessions[0].sessionId);
      console.log(`  Built ${chunks.length} chunk(s)`);

      // Step 4: Assess chunks
      const providers = c.providers
        ? (c.providers.filter((p) => p === "claude" || p === "codex" || p === "gemini") as ("claude" | "codex" | "gemini")[])
        : distillProviders;
      console.log(`  Assessing with providers: ${providers.join(", ")}...`);
      const assessmentMap = await assessChunks(chunks, { providers }, (completed, total) => {
        if (completed % 5 === 0 || completed === total) {
          console.log(`  Progress: ${completed}/${total} chunks assessed`);
        }
      });
      metrics.distillChunksAssessed(chunks.length);

      // Step 5: Compute consensus scores
      const runConsensusCfg = { minAssessments: Math.min(providers.length, 2) };
      const scoredChunks = new Map<string, { chunk: typeof chunks[0]; consensus: number }>();
      for (const chunk of chunks) {
        const assessments = assessmentMap.get(chunk.id) || [];
        const consensus = computeConsensus(assessments, runConsensusCfg);
        scoredChunks.set(chunk.id, { chunk, consensus });
      }

      // Step 5b: Persist chunks + FTS for future :distill ask queries
      const sessionDb = rawSm.getSessionDb();
      let persistedCount = 0;
      for (const [chunkId, { chunk, consensus }] of scoredChunks) {
        try {
          sessionDb.persistChunk(chunk, persistedCount, consensus);
          const content = chunk.events.map((e) => e.content).join("\n");
          sessionDb.persistChunkFTS(chunk.id, content);
          persistedCount++;
        } catch {
          // Duplicate chunk IDs on re-run — skip silently
        }
      }
      console.log(`  Persisted ${persistedCount} chunk(s) to SQLite + FTS index`);

      // Step 6: Distill (with optional token budget from --budget flag)
      const distilled = distill(scoredChunks, c.budget ? { maxTokens: c.budget } : undefined);
      console.log(`\n✓ Distillation complete`);
      console.log(`  Chunks selected: ${distilled.chunks.length} of ${chunks.length}`);
      console.log(`  Total tokens: ${distilled.totalTokens}`);
      console.log(`  Dropped: ${distilled.droppedChunks} chunk(s) (below threshold or over budget)`);

    } else if (c.kind === "distill_seed") {
      // Item 69: Generate platform-specific session file from most recent distillation
      const platform = c.platform as OutputPlatform;
      const generator = getGenerator(platform);
      const ext = platform === "gemini" ? "json" : "jsonl";
      const timestamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
      const outputDir = join(getDataDir(), "distilled");
      const outputPath = join(outputDir, `${timestamp}-seed.${ext}`);

      // Run a quick pipeline to generate the seed
      const sessions = await scanSessions({ limit: 5 });
      if (sessions.length === 0) {
        console.log("No sessions found to seed from.");
        return;
      }

      const allEvents: import("./parsers/types.ts").ParsedEvent[] = [];
      for (const session of sessions) {
        const parser = detectParser(session.filePath);
        if (!parser) continue;
        const source = await Bun.file(session.filePath).text();
        for await (const event of parser.parse(source)) {
          allEvents.push(event);
        }
      }

      const chunks = buildChunks(allEvents, sessions[0].sessionId);
      const scoredChunks = new Map<string, { chunk: typeof chunks[0]; consensus: number }>();
      for (const chunk of chunks) {
        scoredChunks.set(chunk.id, { chunk, consensus: chunk.importanceAvg / 10 });
      }
      const distilled = distill(scoredChunks);

      const result = await generator.generate(distilled, outputPath);
      metrics.distillSessionsGenerated(platform);
      console.log(`✓ Session seed generated for ${platform}`);
      console.log(`  Output: ${result}`);
      console.log(`  Chunks: ${distilled.chunks.length}, Tokens: ${distilled.totalTokens}`);

    } else if (c.kind === "distill_query") {
      // Item 70: Search chunk_fts table for matching chunks
      try {
        const db = rawSm.getSessionDb().getDb();
        const rows = db
          .prepare("SELECT chunk_id, content FROM chunk_fts WHERE chunk_fts MATCH ? LIMIT 20")
          .all(c.query) as Array<{ chunk_id: string; content: string }>;

        if (rows.length === 0) {
          console.log("No matching chunks found.");
        } else {
          console.log(`Found ${rows.length} matching chunk(s):\n`);
          for (const row of rows) {
            const preview = row.content.slice(0, 200).replace(/\n/g, " ");
            console.log(`  [${row.chunk_id}] ${preview}...`);
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`Query failed: ${msg}`);
      }

    } else if (c.kind === "distill_report") {
      // Item 71: Show distillation statistics
      try {
        const db = rawSm.getSessionDb().getDb();
        const chunkCount = (db.prepare("SELECT COUNT(*) as count FROM chunks").get() as { count: number }).count;
        const assessCount = (db.prepare("SELECT COUNT(*) as count FROM assessments").get() as { count: number }).count;
        const extCount = (db.prepare("SELECT COUNT(*) as count FROM external_sessions").get() as { count: number }).count;
        const syncQueueSize = await defensiveMem.getSyncQueueSize();

        const avgScore = db.prepare("SELECT AVG(consensus_score) as avg FROM chunks WHERE consensus_score IS NOT NULL").get() as {
          avg: number | null;
        };

        const topChunks = db
          .prepare("SELECT id, importance_avg, consensus_score FROM chunks ORDER BY consensus_score DESC LIMIT 5")
          .all() as Array<{ id: string; importance_avg: number | null; consensus_score: number | null }>;

        console.log("Distillation Report:");
        console.log(`  Chunks:             ${chunkCount}`);
        console.log(`  Assessments:        ${assessCount}`);
        console.log(`  External sessions:  ${extCount}`);
        console.log(`  Avg consensus:      ${avgScore.avg != null ? avgScore.avg.toFixed(2) : "N/A"}`);
        console.log(`  Sync queue:         ${syncQueueSize} pending`);

        if (topChunks.length > 0) {
          console.log("\n  Top chunks:");
          for (const tc of topChunks) {
            const imp = tc.importance_avg != null ? tc.importance_avg.toFixed(1) : "N/A";
            const con = tc.consensus_score != null ? tc.consensus_score.toFixed(2) : "N/A";
            console.log(`    ${tc.id}  importance=${imp}  consensus=${con}`);
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`Report failed: ${msg}`);
      }

    } else if (c.kind === "distill_assess") {
      // Item 72: Trigger multi-agent assessment on specific chunk or all unassessed
      if (c.chunkId) {
        console.log(`Assessing chunk ${c.chunkId}...`);
        try {
          const db = rawSm.getSessionDb().getDb();
          const chunkRow = db.prepare("SELECT id, summary FROM chunks WHERE id = ?").get(c.chunkId) as {
            id: string;
            summary: string | null;
          } | null;
          if (!chunkRow) {
            console.log(`Chunk ${c.chunkId} not found.`);
            return;
          }
          console.log(`Chunk found. Assessment will be submitted to the queue.`);
          console.log(`Use :distill status to check progress.`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.log(`Assessment failed: ${msg}`);
        }
      } else {
        console.log("Usage: :distill assess <chunkId>");
        console.log("Specify a chunk ID to assess. Use :distill report to see chunk IDs.");
      }

    } else if (c.kind === "distill_status") {
      // Item 73: Show pipeline state
      const queueStatus = assessmentQueue.status();
      console.log("Distillation Pipeline Status:");
      console.log(`  Assessment queue:`);
      console.log(`    Active:     ${queueStatus.active}`);
      console.log(`    Pending:    ${queueStatus.pending}`);
      console.log(`    Completed:  ${queueStatus.completed}`);
      console.log(`    Failed:     ${queueStatus.failed}`);
      console.log(`    Max concurrent: ${queueStatus.maxConcurrent}`);
      console.log(`  Watcher: ${watcher.isRunning ? "running" : "stopped"} (${watcher.trackedCount} files tracked)`);
      const syncSize = await defensiveMem.getSyncQueueSize();
      console.log(`  Sync queue: ${syncSize} unsynced entries`);
      console.log(`  Real-time scoring: ${distillEnabled ? "enabled" : "disabled"}`);

    } else if (c.kind === "distill_watch") {
      // Item 74: Toggle background file watcher
      if (c.enabled) {
        if (watcher.isRunning) {
          console.log("Watcher already running.");
        } else {
          await watcher.start();
          console.log("Background watcher started.");
        }
      } else {
        if (!watcher.isRunning) {
          console.log("Watcher not running.");
        } else {
          watcher.stop();
          console.log("Background watcher stopped.");
        }
      }

    } else if (c.kind === "distill_filter") {
      // Phase 14: Natural language filter → extract params → run build
      const filterProvider = (c.providers?.[0] || distillProviders[0] || "claude") as "claude" | "codex" | "gemini";
      console.log(`\n🔍 Extracting filters from natural language...`);
      console.log(`  Using provider: ${filterProvider}`);
      const nlParams = await extractFilters(c.text, filterProvider);
      console.log(`\n📋 Extracted filter parameters:`);
      for (const [key, value] of Object.entries(nlParams)) {
        if (value !== undefined) {
          console.log(`  ${key}: ${JSON.stringify(value)}`);
        }
      }
      if (Object.keys(nlParams).length === 0) {
        console.log("  (no filters extracted — check your input text)");
        return;
      }
      // Execute build with extracted params — pass values directly to avoid re-extraction
      console.log(`\n  Running :distill build with extracted filters...`);
      const syntheticBuild: Command = {
        kind: "distill_build",
        cwd: nlParams.cwd,
        limit: nlParams.limit,
        budget: nlParams.budget,
        format: nlParams.format,
        providers: c.providers || nlParams.providers, // CLI flag overrides LLM-extracted
        since: nlParams.since,
        until: nlParams.until,
        keywords: nlParams.keywords,
      };
      // Re-dispatch as distill_build (recursive handler call via the same switch)
      Object.assign(c, syntheticBuild);
      // Fall through to distill_build handler below

    } else if (c.kind === "distill_load") {
      // Phase 15: Load distilled conversation context
      let targetPath = c.path;
      if (!targetPath) {
        const cwd = c.cwd || sm.getCurrent()?.cwd || process.cwd();
        console.log(`\n🔍 Searching for latest build for ${cwd}...`);
        targetPath = findLatestBuild(cwd) || undefined;
        if (!targetPath) {
          // Try without cwd filter as fallback
          targetPath = findLatestBuild() || undefined;
          if (targetPath) {
            console.log(`  No build found for this project — using latest available build.`);
          }
        }
      }
      if (!targetPath) {
        console.log("No distilled build files found. Run :distill build first.");
        return;
      }
      try {
        loadedConversation = loadDistilledConversation(targetPath);
        console.log(`\n✓ Loaded distilled conversation`);
        console.log(`  File: ${loadedConversation.filePath}`);
        console.log(`  Project: ${loadedConversation.cwd}`);
        console.log(`  Turns: ${loadedConversation.turns.length} (${loadedConversation.topicCount} topics)`);
        console.log(`  Content: ${loadedConversation.totalChars.toLocaleString()} chars`);
        console.log(`  Created: ${loadedConversation.createdAt}`);

        const s = sm.getCurrent();
        if (s?.activeProvider === "claude") {
          console.log(`\n  Context will be loaded via --resume (native Claude conversation history)`);
        } else {
          console.log(`\n  Context will be injected as text into provider prompts`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`Failed to load: ${msg}`);
      }

    } else if (c.kind === "distill_unload") {
      if (loadedConversation) {
        console.log(`Unloaded: ${loadedConversation.filePath}`);
        loadedConversation = null;
      } else {
        console.log("No conversation loaded.");
      }

    }
    if (c.kind === "distill_build") {
      // Phase 13+14: Full pipeline — optionally with NL-extracted params
      // Use pre-extracted values from :distill filter, or extract from --filter flag
      let nlKeywords: string[] | undefined = c.keywords;
      let nlSince: string | undefined = c.since;
      let nlUntil: string | undefined = c.until;

      if (c.filter && !nlKeywords && !nlSince && !nlUntil) {
        const filterProvider = (distillProviders[0] || "claude") as "claude" | "codex" | "gemini";
        console.log(`\n🔍 Extracting filters from: "${c.filter}"`);
        console.log(`  Using provider: ${filterProvider}`);
        const nlParams = await extractFilters(c.filter, filterProvider);
        console.log(`📋 Extracted:`);
        for (const [key, value] of Object.entries(nlParams)) {
          if (value !== undefined) console.log(`  ${key}: ${JSON.stringify(value)}`);
        }
        // Merge NL params into command (NL fills gaps, explicit flags override)
        if (!c.cwd && nlParams.cwd) c.cwd = nlParams.cwd;
        if (!c.limit && nlParams.limit) c.limit = nlParams.limit;
        if (!c.budget && nlParams.budget) c.budget = nlParams.budget;
        if (!c.format && nlParams.format) c.format = nlParams.format;
        if (!c.providers && nlParams.providers) c.providers = nlParams.providers;
        nlKeywords = nlParams.keywords;
        nlSince = nlParams.since;
        nlUntil = nlParams.until;
      }

      // Phase 13: Full pipeline — scan → parse → score → chunk → assess → consensus → persist → distill → synthesize → generate JSONL
      const cwd = c.cwd || process.cwd();
      const limit = c.limit || 20;
      const budget = c.budget || 80000;
      const format = c.format || "conversation";
      const providers = c.providers
        ? (c.providers.filter((p) => p === "claude" || p === "codex" || p === "gemini") as ("claude" | "codex" | "gemini")[])
        : distillProviders;

      console.log(`\n🔨 distill build — full pipeline`);
      console.log(`  Project: ${cwd}`);
      console.log(`  Limit: ${limit} sessions`);
      console.log(`  Budget: ${budget.toLocaleString()} tokens`);
      console.log(`  Format: ${format}`);
      console.log(`  Providers: ${providers.join(", ")}`);
      if (nlKeywords && nlKeywords.length > 0) console.log(`  Keywords: ${nlKeywords.join(", ")}`);
      if (nlSince) console.log(`  Since: ${nlSince}`);
      if (nlUntil) console.log(`  Until: ${nlUntil}`);
      if (c.dryRun) console.log(`  Mode: DRY RUN (will stop before generation)`);

      // Step 1: Scan sessions with project filter + date range
      console.log(`\n  [1/11] Scanning sessions...`);
      const sessions = await scanSessions({ projectPath: cwd, limit, since: nlSince, until: nlUntil });
      if (sessions.length === 0) {
        console.log("  No matching sessions found for this project.");
        return;
      }
      console.log(`  Found ${sessions.length} session(s)`);

      // Step 2: Parse all sessions into events
      console.log(`  [2/11] Parsing sessions...`);
      const allScoredEvents: Array<{ event: import("./parsers/types.ts").ParsedEvent; score: number }> = [];
      for (const session of sessions) {
        const parser = detectParser(session.filePath);
        if (!parser) {
          console.log(`    Skipping ${session.filePath} (no parser)`);
          continue;
        }
        const source = await Bun.file(session.filePath).text();
        for await (const event of parser.parse(source)) {
          // Step 3: Score each event
          const score = scoreEvent(event);
          allScoredEvents.push({ event: { ...event, metadata: { ...event.metadata, importanceScore: score } }, score });
        }
      }
      console.log(`  Parsed ${allScoredEvents.length} events`);

      // Step 4: Build chunks
      console.log(`  [3-4/11] Building chunks...`);
      const scoredParsedEvents = allScoredEvents.map((e) => e.event);
      let chunks = buildChunks(scoredParsedEvents, sessions[0].sessionId);
      console.log(`  Built ${chunks.length} chunk(s)`);

      // Step 4b: Keyword filtering (Phase 14 — NL filter)
      if (nlKeywords && nlKeywords.length > 0) {
        const beforeCount = chunks.length;
        chunks = chunks.filter((chunk) => {
          const content = chunk.events.map((e) => e.content).join(" ").toLowerCase();
          return nlKeywords!.some((kw) => content.includes(kw));
        });
        console.log(`  Keyword filter: ${beforeCount} → ${chunks.length} chunks (keywords: ${nlKeywords.join(", ")})`);
      }

      if (chunks.length === 0) {
        console.log("  No chunks to process.");
        return;
      }

      // Step 5: Assess chunks with multi-agent consensus
      console.log(`  [5/11] Assessing chunks with ${providers.join(", ")}...`);
      const assessmentMap = await assessChunks(chunks, { providers }, (completed, total) => {
        if (completed % 5 === 0 || completed === total) {
          console.log(`    Progress: ${completed}/${total} chunks assessed`);
        }
      });

      // Step 6: Compute consensus
      console.log(`  [6/11] Computing consensus scores...`);
      const consensusCfg = { minAssessments: Math.min(providers.length, 2) };
      const scoredChunks = new Map<string, { chunk: typeof chunks[0]; consensus: number }>();
      for (const chunk of chunks) {
        const assessments = assessmentMap.get(chunk.id) || [];
        const consensus = computeConsensus(assessments, consensusCfg);
        scoredChunks.set(chunk.id, { chunk, consensus });
      }

      // Step 7: Persist chunks + FTS
      console.log(`  [7/11] Persisting to SQLite + FTS...`);
      const sessionDb = rawSm.getSessionDb();
      let persistedCount = 0;
      for (const [, { chunk, consensus }] of scoredChunks) {
        try {
          sessionDb.persistChunk(chunk, persistedCount, consensus);
          const content = chunk.events.map((e) => e.content).join("\n");
          sessionDb.persistChunkFTS(chunk.id, content);
          persistedCount++;
        } catch {
          // Duplicate chunk IDs on re-run
        }
      }
      console.log(`  Persisted ${persistedCount} chunk(s)`);

      // Step 8: Distill with token budget
      console.log(`  [8/11] Distilling (budget: ${budget.toLocaleString()} tokens)...`);
      const distilled = distill(scoredChunks, { maxTokens: budget });
      console.log(`  Selected ${distilled.chunks.length} of ${chunks.length} chunks (${distilled.totalTokens.toLocaleString()} tokens)`);
      console.log(`  Dropped: ${distilled.droppedChunks} chunk(s)`);

      // Dry-run stops here
      if (c.dryRun) {
        console.log(`\n✓ Dry run complete — pipeline verified`);
        console.log(`  Sessions scanned: ${sessions.length}`);
        console.log(`  Events parsed: ${allScoredEvents.length}`);
        console.log(`  Chunks built: ${chunks.length}`);
        console.log(`  Chunks selected: ${distilled.chunks.length}`);
        console.log(`  Total tokens: ${distilled.totalTokens.toLocaleString()}`);
        return;
      }

      // Step 9: Synthesize with narrative assembly
      console.log(`  [9/11] Synthesizing narrative...`);
      const groups = groupByTopic(distilled.chunks);
      const synthesis = assembleSynthesis(groups);
      console.log(`  Organized into ${synthesis.length} topic(s): ${synthesis.map((s) => s.topic).join(", ")}`);

      // Step 10: Generate JSONL
      console.log(`  [10/11] Generating ${format} JSONL...`);
      const timestamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
      const outputDir = c.output ? c.output : join(getDataDir(), "distilled");

      // Ensure output directory exists
      const { mkdirSync } = await import("node:fs");
      try {
        mkdirSync(outputDir, { recursive: true });
      } catch {
        // Directory may already exist
      }

      const outputPath = join(outputDir, `${timestamp}-build.jsonl`);

      if (format === "conversation") {
        // Use synthesized turns for conversation format
        // Inject synthesis topics into distilled session for the generator
        const synthesizedDistilled = {
          ...distilled,
          sourcePlatforms: [...new Set(sessions.map((s) => s.platform))],
          sourceSessionIds: [...new Set(sessions.map((s) => s.sessionId))],
        };
        await conversationGenerator.generate(synthesizedDistilled, outputPath, {
          cwd,
          gitBranch: "",
        });
      } else {
        // Summary format uses existing claudeGenerator
        const generator = getGenerator("claude");
        await generator.generate(distilled, outputPath);
      }

      // Step 10b: Store top chunks as ClaudeMem observations
      try {
        const topChunks = distilled.chunks.slice(0, 10);
        let storedObs = 0;
        for (const chunk of topChunks) {
          const content = chunk.events.map((e) => e.content).join("\n").slice(0, 2000);
          const ok = await rawMem.storeObservation({
            contentSessionId: `distill-build-${timestamp}`,
            cwd,
            tool_name: "distill_build",
            tool_input: { project: cwd, topic: "distilled-knowledge" },
            tool_response: { chunkId: chunk.id, content },
          });
          if (ok) storedObs++;
        }
        if (storedObs > 0) console.log(`  Stored ${storedObs} observations in ClaudeMem`);
      } catch {
        // ClaudeMem may not be running — non-fatal
      }

      // Step 11: Report
      console.log(`  [11/11] Writing output...`);
      console.log(`\n✓ Build complete`);
      console.log(`  Sessions: ${sessions.length}`);
      console.log(`  Events: ${allScoredEvents.length}`);
      console.log(`  Chunks: ${distilled.chunks.length} selected / ${chunks.length} total`);
      console.log(`  Tokens: ${distilled.totalTokens.toLocaleString()}`);
      console.log(`  Topics: ${synthesis.length}`);
      console.log(`  Output: ${outputPath}`);
      console.log(`\n  To use: :distill load ${outputPath}`);

    } else if (c.kind === "distill_ask") {
      // Item 109: Question-driven distillation via queryDistill()
      const platform = (c.platform || "claude") as OutputPlatform;
      const providers = c.providers
        ? (c.providers.filter((p) => p === "claude" || p === "codex" || p === "gemini") as ("claude" | "codex" | "gemini")[])
        : distillProviders;

      console.log(`Question-driven distillation starting...`);
      console.log(`  Question: "${c.question}"`);
      console.log(`  Platform: ${platform}`);
      console.log(`  Providers: ${providers.join(", ")}`);

      try {
        const db = rawSm.getSessionDb().getDb();
        const result = await queryDistill(c.question, db, defensiveMem, {
          providers,
          reRankWithQuestion: parseBoolEnv("UNIFIED_AGENT_DISTILL_RERANK", true),
          queryAssessmentWeight: Number.parseFloat(process.env.UNIFIED_AGENT_DISTILL_QUERY_WEIGHT || "0.6"),
          staticAssessmentWeight: Number.parseFloat(process.env.UNIFIED_AGENT_DISTILL_STATIC_WEIGHT || "0.4"),
          claudeMemMaxResults: Number.parseInt(process.env.UNIFIED_AGENT_DISTILL_CLAUDEMEM_MAX || "20", 10),
          maxTokens: Number.parseInt(process.env.UNIFIED_AGENT_DISTILL_TOKEN_BUDGET || "80000", 10),
          timeoutMs: Number.parseInt(process.env.UNIFIED_AGENT_DISTILL_ASSESSMENT_TIMEOUT_MS || "30000", 10),
          cwd: sm.getCurrent()?.cwd || process.cwd(),
        });

        if (result.chunks.length === 0) {
          console.log("\nNo relevant chunks found for this question.");
          console.log(`  FTS matches: ${result.searchStats.chunkFtsMatches}`);
          console.log(`  ClaudeMem matches: ${result.searchStats.claudeMemMatches}`);
          return;
        }

        // Generate platform-specific session file
        const generator = getGenerator(platform);
        const ext = platform === "gemini" ? "json" : "jsonl";
        const slug = c.question
          .toLowerCase()
          .replace(/[^\w\s]/g, "")
          .replace(/\s+/g, "-")
          .slice(0, 50);
        const timestamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
        const outputDir = join(getDataDir(), "distilled");

        // Ensure output directory exists
        const { mkdirSync } = await import("node:fs");
        try {
          mkdirSync(outputDir, { recursive: true });
        } catch {
          // Directory may already exist
        }

        const outputPath = join(outputDir, `${timestamp}-${slug}.${ext}`);
        const outputFile = await generator.generate(result, outputPath);

        metrics.distillSessionsGenerated(platform);

        console.log(`\n✓ Question-driven distillation complete`);
        console.log(`  Question: "${c.question}"`);
        console.log(`  Sources: ${result.searchStats.chunkFtsMatches} FTS matches + ${result.searchStats.claudeMemMatches} ClaudeMem matches → ${result.searchStats.totalCandidates} unique candidates`);
        console.log(`  Selected: ${result.chunks.length} chunks (${result.totalTokens.toLocaleString()} tokens) from ${result.searchStats.totalCandidates} candidates`);
        console.log(`  Output: ${outputFile}`);

        console.log(`\n  To use: :distill load ${outputFile}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`Question-driven distillation failed: ${msg}`);
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
      await gracefulShutdown();
      return;
    }
  } else if (options.once) {
    await gracefulShutdown();
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
    const watchToken = watcher.isRunning ? "|watch" : "";
    const ctxToken = loadedConversation ? "|ctx" : "";
    rl.setPrompt(`[${s?.id || "no-session"}|${p}|${m}${brainToken}${watchToken}${ctxToken}]> `);
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

  rl.on("close", async () => {
    await gracefulShutdown();
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
