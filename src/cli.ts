#!/usr/bin/env bun
import { runRepl } from "./repl";
import type { ProviderName } from "./session/types";

interface CliArgs {
  prompt?: string;
  once?: boolean;
  provider?: ProviderName;
  model?: string;
  project?: string;
  contextMode?: "off" | "recent" | "full";
  contextTurns?: number;
  contextChars?: number;
  includeMemoryInject?: boolean;
  help?: boolean;
}

function parseArgs(argv: string[]): CliArgs {
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
}

let args: CliArgs;
try {
  args = parseArgs(process.argv.slice(2));
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  printUsage();
  process.exit(1);
}
if (args.help) {
  printUsage();
  process.exit(0);
}

await runRepl({
  initialPrompt: args.prompt,
  once: args.once,
  provider: args.provider,
  model: args.model,
  project: args.project,
  contextMode: args.contextMode,
  contextTurns: args.contextTurns,
  contextChars: args.contextChars,
  includeMemoryInject: args.includeMemoryInject,
});
