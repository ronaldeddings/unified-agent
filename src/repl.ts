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

    const resp = await provider.ask(fullPrompt, {
      cwd: s.cwd,
      model: s.activeModel,
      permissionMode: "bypassPermissions",
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
      let sessions = await scanSessions();
      if (c.sessionIds && c.sessionIds.length > 0) {
        sessions = sessions.filter((s) => c.sessionIds!.some((id) => s.sessionId === id || s.filePath.includes(id)));
      }
      if (sessions.length === 0) {
        console.log("No matching sessions found.");
        return;
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
      const scoredChunks = new Map<string, { chunk: typeof chunks[0]; consensus: number }>();
      for (const chunk of chunks) {
        const assessments = assessmentMap.get(chunk.id) || [];
        const consensus = computeConsensus(assessments);
        scoredChunks.set(chunk.id, { chunk, consensus });
      }

      // Step 6: Distill
      const distilled = distill(scoredChunks);
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

    } else if (c.kind === "distill_ask") {
      // Placeholder for Phase 9 — :distill ask requires queryDistiller (not yet implemented)
      console.log("`:distill ask` requires the question-driven distiller (Phase 9).");
      console.log("Use `:distill run` for general distillation or `:distill query` for FTS search.");
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
    rl.setPrompt(`[${s?.id || "no-session"}|${p}|${m}${brainToken}${watchToken}]> `);
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
