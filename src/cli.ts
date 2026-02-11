#!/usr/bin/env bun
import { runRepl } from "./repl";
import type { ProviderName } from "./session/types";

interface CliArgs {
  prompt?: string;
  once?: boolean;
  provider?: ProviderName;
  model?: string;
  brainUrl?: string;
  brainProvider?: ProviderName;
  brainSessionId?: string;
  project?: string;
  contextMode?: "off" | "recent" | "full";
  contextTurns?: number;
  contextChars?: number;
  includeMemoryInject?: boolean;
  help?: boolean;
}

const BRAIN_PROVIDER_VALUES = new Set<ProviderName>(["claude", "codex", "gemini", "mock"]);

export function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {};
  const promptParts: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      out.help = true;
      continue;
    }
    if (a === "--once") {
      out.once = true;
      continue;
    }
    if (a === "--provider") {
      const p = (argv[++i] || "").toLowerCase();
      if (p !== "claude" && p !== "codex" && p !== "gemini" && p !== "mock") {
        throw new Error(`invalid provider: ${p}`);
      }
      out.provider = p as ProviderName;
      continue;
    }
    if (a === "--model") {
      const m = (argv[++i] || "").trim();
      if (!m) throw new Error("--model requires a value");
      out.model = m;
      continue;
    }
    if (a === "--brain-url") {
      const raw = (argv[++i] || "").trim();
      if (!raw) throw new Error("--brain-url requires a value");
      let parsed: URL;
      try {
        parsed = new URL(raw);
      } catch {
        throw new Error(`invalid --brain-url: ${raw}`);
      }
      if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
        throw new Error("--brain-url must use ws:// or wss://");
      }
      out.brainUrl = parsed.toString();
      continue;
    }
    if (a === "--brain-provider") {
      const p = (argv[++i] || "").toLowerCase() as ProviderName;
      if (!BRAIN_PROVIDER_VALUES.has(p)) {
        throw new Error(`invalid --brain-provider: ${p}`);
      }
      out.brainProvider = p;
      continue;
    }
    if (a === "--brain-session-id") {
      const id = (argv[++i] || "").trim();
      if (!id) throw new Error("--brain-session-id requires a value");
      out.brainSessionId = id;
      continue;
    }
    if (a === "--project") {
      out.project = argv[++i] || "default";
      continue;
    }
    if (a === "--context-mode") {
      const mode = (argv[++i] || "").toLowerCase();
      if (mode !== "off" && mode !== "recent" && mode !== "full") {
        throw new Error(`invalid context mode: ${mode}`);
      }
      out.contextMode = mode as "off" | "recent" | "full";
      continue;
    }
    if (a === "--context-turns") {
      const n = Number.parseInt(argv[++i] || "", 10);
      if (!Number.isFinite(n) || n <= 0) throw new Error("--context-turns must be > 0");
      out.contextTurns = n;
      continue;
    }
    if (a === "--context-chars") {
      const n = Number.parseInt(argv[++i] || "", 10);
      if (!Number.isFinite(n) || n <= 0) throw new Error("--context-chars must be > 0");
      out.contextChars = n;
      continue;
    }
    if (a === "--mem") {
      const v = (argv[++i] || "").toLowerCase();
      if (v === "on" || v === "true" || v === "1") out.includeMemoryInject = true;
      else if (v === "off" || v === "false" || v === "0") out.includeMemoryInject = false;
      else throw new Error("--mem expects on|off");
      continue;
    }
    if (a === "--prompt" || a === "-p") {
      const p = argv[++i];
      if (!p) throw new Error(`${a} requires a value`);
      promptParts.push(p);
      continue;
    }
    promptParts.push(a);
  }

  const prompt = promptParts.join(" ").trim();
  if (prompt) out.prompt = prompt;
  return out;
}

function printUsage(): void {
  console.log("Usage:");
  console.log("  unified");
  console.log("  unified \"your prompt here\"");
  console.log("  unified --provider codex \"your prompt here\"");
  console.log("  unified --once --provider claude --model claude-sonnet-4-20250514 --prompt \"one shot\"");
  console.log("  unified --project myproj");
  console.log("  unified --mem off --context-mode recent --context-turns 20 \"prompt\"");
  console.log("  unified --brain-url wss://brain.example/ws --brain-provider claude --brain-session-id sess_123");
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    printUsage();
    process.exit(1);
    return;
  }
  if (args.help) {
    printUsage();
    process.exit(0);
    return;
  }

  await runRepl({
    initialPrompt: args.prompt,
    once: args.once,
    provider: args.provider,
    model: args.model,
    brainUrl: args.brainUrl,
    brainProvider: args.brainProvider,
    brainSessionId: args.brainSessionId,
    project: args.project,
    contextMode: args.contextMode,
    contextTurns: args.contextTurns,
    contextChars: args.contextChars,
    includeMemoryInject: args.includeMemoryInject,
  });
}

if (import.meta.main) {
  await main();
}
