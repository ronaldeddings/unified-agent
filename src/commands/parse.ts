import type { ProviderName } from "../session/types";

export type Command =
  | { kind: "help" }
  | { kind: "quit" }
  | { kind: "provider"; provider: ProviderName }
  | { kind: "model"; model?: string }
  | { kind: "session_new"; project?: string }
  | { kind: "session_list" }
  | { kind: "session_resume"; id: string }
  | { kind: "context_show" }
  | { kind: "context_mode"; mode: "off" | "recent" | "full" }
  | { kind: "context_turns"; turns: number }
  | { kind: "context_chars"; chars: number }
  | { kind: "context_mem"; enabled: boolean }
  | { kind: "mem_inject" }
  | { kind: "mem_stats" }
  | { kind: "mem_search"; query: string }
  | { kind: "mem_note"; text: string }
  | { kind: "brain_connect"; url: string; provider?: ProviderName; sessionId?: string }
  | { kind: "brain_disconnect" }
  | { kind: "brain_status" }
  | { kind: "brain_replay"; sessionId: string }
  | { kind: "distill_scan" }
  | { kind: "distill_run"; sessionIds?: string[]; providers?: string[]; cwd?: string; limit?: number; budget?: number; output?: string; format?: "conversation" | "summary" }
  | { kind: "distill_seed"; platform: string; sessionId?: string }
  | { kind: "distill_ask"; question: string; platform?: string; providers?: string[]; cwd?: string; limit?: number; budget?: number }
  | { kind: "distill_query"; query: string }
  | { kind: "distill_report"; sessionId?: string }
  | { kind: "distill_assess"; chunkId?: string }
  | { kind: "distill_status" }
  | { kind: "distill_watch"; enabled: boolean }
  | { kind: "distill_build"; cwd?: string; limit?: number; budget?: number; output?: string; format?: "conversation" | "summary"; providers?: string[]; dryRun?: boolean; filter?: string; since?: string; until?: string; keywords?: string[] }
  | { kind: "distill_filter"; text: string; providers?: string[] }
  | { kind: "distill_load"; path?: string; cwd?: string }
  | { kind: "distill_unload" };

/**
 * Shared distill flags parsed from --cwd, --limit, --budget, --output, --platform, --providers.
 */
interface DistillFlags {
  platform: string;
  providers: string[];
  cwd: string;
  limit: number;
  budget: number;
  output: string;
  format: string;
  filter: string;
}

/**
 * Parse shared distill flags from a whitespace-split array of tokens.
 * Recognizes: --cwd, --limit, --budget, --output, --platform, --providers
 * Returns the flags and any remaining non-flag tokens.
 */
function parseDistillFlags(flagParts: string[]): { flags: DistillFlags; remaining: string[] } {
  const flags: DistillFlags = { platform: "", providers: [], cwd: "", limit: 0, budget: 0, output: "", format: "", filter: "" };
  const remaining: string[] = [];

  for (let i = 0; i < flagParts.length; i++) {
    const part = flagParts[i];
    if (part === "--platform" && flagParts[i + 1]) {
      flags.platform = flagParts[i + 1].toLowerCase();
      i++;
    } else if (part === "--providers" && flagParts[i + 1]) {
      flags.providers = flagParts[i + 1].split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
      i++;
    } else if (part === "--cwd" && flagParts[i + 1]) {
      flags.cwd = flagParts[i + 1];
      i++;
    } else if (part === "--limit" && flagParts[i + 1]) {
      const n = Number.parseInt(flagParts[i + 1], 10);
      if (Number.isFinite(n) && n > 0) flags.limit = n;
      i++;
    } else if (part === "--budget" && flagParts[i + 1]) {
      const n = Number.parseInt(flagParts[i + 1], 10);
      if (Number.isFinite(n) && n > 0) flags.budget = n;
      i++;
    } else if (part === "--output" && flagParts[i + 1]) {
      flags.output = flagParts[i + 1];
      i++;
    } else if (part === "--format" && flagParts[i + 1]) {
      const f = flagParts[i + 1].toLowerCase();
      if (f === "conversation" || f === "summary") flags.format = f;
      i++;
    } else if (part === "--filter" && flagParts[i + 1]) {
      // Collect all tokens until the next --flag as the filter text
      const filterParts: string[] = [];
      for (let j = i + 1; j < flagParts.length; j++) {
        if (flagParts[j].startsWith("--")) break;
        filterParts.push(flagParts[j]);
      }
      flags.filter = filterParts.join(" ").replace(/^["']|["']$/g, "");
      i += filterParts.length;
    } else {
      remaining.push(part);
    }
  }

  return { flags, remaining };
}

/**
 * Parse `:distill ask` arguments: quoted question string + optional flags.
 * Supports: "question" --platform claude --providers claude,codex,gemini --cwd /path --limit 20 --budget 80000
 */
function parseAskArgs(argStr: string): { question: string; flags: DistillFlags } {
  let question = "";

  // Extract quoted question
  const doubleMatch = argStr.match(/^"([^"]+)"/);
  const singleMatch = argStr.match(/^'([^']+)'/);
  let remainder: string;

  if (doubleMatch) {
    question = doubleMatch[1];
    remainder = argStr.slice(doubleMatch[0].length).trim();
  } else if (singleMatch) {
    question = singleMatch[1];
    remainder = argStr.slice(singleMatch[0].length).trim();
  } else {
    // No quotes — take everything before the first --flag as the question
    const flagIdx = argStr.indexOf("--");
    if (flagIdx >= 0) {
      question = argStr.slice(0, flagIdx).trim();
      remainder = argStr.slice(flagIdx).trim();
    } else {
      question = argStr.trim();
      remainder = "";
    }
  }

  // Parse flags from remainder using shared parser
  const { flags } = parseDistillFlags(remainder.split(/\s+/).filter(Boolean));

  return { question, flags };
}

export function parseLine(line: string): { command?: Command; userText?: string } {
  const trimmed = line.trimEnd();
  if (!trimmed) return {};

  if (!trimmed.startsWith(":")) {
    return { userText: trimmed };
  }

  const parts = trimmed.slice(1).trim().split(/\s+/);
  const head = (parts.shift() || "").toLowerCase();
  const rest = parts.join(" ");

  if (head === "help") return { command: { kind: "help" } };
  if (head === "quit" || head === "q" || head === "exit") return { command: { kind: "quit" } };

  if (head === "provider" || head === "p") {
    const p = (parts[0] || "").toLowerCase() as ProviderName;
    if (p !== "claude" && p !== "codex" && p !== "gemini" && p !== "mock") {
      return { command: { kind: "help" } };
    }
    return { command: { kind: "provider", provider: p } };
  }

  if (head === "model" || head === "mod") {
    const value = rest.trim();
    if (!value) return { command: { kind: "help" } };
    const normalized = value.toLowerCase();
    if (normalized === "off" || normalized === "auto" || normalized === "default" || normalized === "none") {
      return { command: { kind: "model", model: undefined } };
    }
    return { command: { kind: "model", model: value } };
  }

  if (head === "session" || head === "s") {
    const sub = (parts[0] || "").toLowerCase();
    if (sub === "new") return { command: { kind: "session_new", project: parts.slice(1).join(" ") || undefined } };
    if (sub === "list") return { command: { kind: "session_list" } };
    if (sub === "resume") {
      const id = parts[1] || "";
      if (!id) return { command: { kind: "help" } };
      return { command: { kind: "session_resume", id } };
    }
    return { command: { kind: "help" } };
  }

  if (head === "context" || head === "ctx") {
    const sub = (parts[0] || "").toLowerCase();
    if (!sub || sub === "show") return { command: { kind: "context_show" } };
    if (sub === "mode") {
      const mode = (parts[1] || "").toLowerCase();
      if (mode === "off" || mode === "recent" || mode === "full") {
        return { command: { kind: "context_mode", mode } };
      }
      return { command: { kind: "help" } };
    }
    if (sub === "turns") {
      const n = Number.parseInt(parts[1] || "", 10);
      if (!Number.isFinite(n) || n <= 0) return { command: { kind: "help" } };
      return { command: { kind: "context_turns", turns: n } };
    }
    if (sub === "chars") {
      const n = Number.parseInt(parts[1] || "", 10);
      if (!Number.isFinite(n) || n <= 0) return { command: { kind: "help" } };
      return { command: { kind: "context_chars", chars: n } };
    }
    if (sub === "mem") {
      const v = (parts[1] || "").toLowerCase();
      if (v === "on" || v === "true" || v === "1") return { command: { kind: "context_mem", enabled: true } };
      if (v === "off" || v === "false" || v === "0") return { command: { kind: "context_mem", enabled: false } };
      return { command: { kind: "help" } };
    }
    return { command: { kind: "help" } };
  }

  if (head === "mem") {
    const sub = (parts[0] || "").toLowerCase();
    if (sub === "inject") return { command: { kind: "mem_inject" } };
    if (sub === "stats") return { command: { kind: "mem_stats" } };
    if (sub === "search") {
      const query = parts.slice(1).join(" ").trim();
      if (!query) return { command: { kind: "help" } };
      return { command: { kind: "mem_search", query } };
    }
    if (sub === "note") {
      const text = parts.slice(1).join(" ").trim();
      if (!text) return { command: { kind: "help" } };
      return { command: { kind: "mem_note", text } };
    }
    return { command: { kind: "help" } };
  }

  if (head === "distill" || head === "d") {
    const sub = (parts[0] || "").toLowerCase();
    if (sub === "scan") return { command: { kind: "distill_scan" } };
    if (sub === "status") return { command: { kind: "distill_status" } };
    if (sub === "run") {
      const { flags, remaining } = parseDistillFlags(parts.slice(1));
      const sessionIds = remaining.filter(Boolean);
      return {
        command: {
          kind: "distill_run",
          sessionIds: sessionIds.length > 0 ? sessionIds : undefined,
          providers: flags.providers.length > 0 ? flags.providers : undefined,
          cwd: flags.cwd || undefined,
          limit: flags.limit || undefined,
          budget: flags.budget || undefined,
          output: flags.output || undefined,
          format: (flags.format === "conversation" || flags.format === "summary") ? flags.format : undefined,
        },
      };
    }
    if (sub === "seed") {
      const platform = (parts[1] || "").toLowerCase();
      if (platform !== "claude" && platform !== "codex" && platform !== "gemini") {
        return { command: { kind: "help" } };
      }
      const sessionId = (parts[2] || "").trim() || undefined;
      return { command: { kind: "distill_seed", platform, sessionId } };
    }
    if (sub === "query") {
      const query = parts.slice(1).join(" ").trim();
      if (!query) return { command: { kind: "help" } };
      return { command: { kind: "distill_query", query } };
    }
    if (sub === "report") {
      const sessionId = (parts[1] || "").trim() || undefined;
      return { command: { kind: "distill_report", sessionId } };
    }
    if (sub === "assess") {
      const chunkId = (parts[1] || "").trim() || undefined;
      return { command: { kind: "distill_assess", chunkId } };
    }
    if (sub === "watch") {
      const v = (parts[1] || "").toLowerCase();
      if (v === "on" || v === "true" || v === "1") return { command: { kind: "distill_watch", enabled: true } };
      if (v === "off" || v === "false" || v === "0") return { command: { kind: "distill_watch", enabled: false } };
      return { command: { kind: "help" } };
    }
    if (sub === "ask") {
      // Parse quoted question and optional flags
      const argStr = parts.slice(1).join(" ");
      const { question, flags } = parseAskArgs(argStr);
      if (!question) return { command: { kind: "help" } };
      return {
        command: {
          kind: "distill_ask",
          question,
          platform: flags.platform || undefined,
          providers: flags.providers.length > 0 ? flags.providers : undefined,
          cwd: flags.cwd || undefined,
          limit: flags.limit || undefined,
          budget: flags.budget || undefined,
        },
      };
    }
    if (sub === "build") {
      const { flags } = parseDistillFlags(parts.slice(1));
      const hasDryRun = parts.slice(1).some((p) => p === "--dry-run");
      return {
        command: {
          kind: "distill_build",
          cwd: flags.cwd || undefined,
          limit: flags.limit || undefined,
          budget: flags.budget || undefined,
          output: flags.output || undefined,
          format: (flags.format === "conversation" || flags.format === "summary") ? flags.format : undefined,
          providers: flags.providers.length > 0 ? flags.providers : undefined,
          dryRun: hasDryRun || undefined,
          filter: flags.filter || undefined,
        },
      };
    }
    if (sub === "filter") {
      // :distill filter "natural language text" [--providers claude,codex]
      const argStr = parts.slice(1).join(" ");
      const { question: text, flags } = parseAskArgs(argStr);
      if (!text) return { command: { kind: "help" } };
      return {
        command: {
          kind: "distill_filter",
          text,
          providers: flags.providers.length > 0 ? flags.providers : undefined,
        },
      };
    }
    if (sub === "preview") {
      // Alias for :distill build --dry-run
      const { flags } = parseDistillFlags(parts.slice(1));
      return {
        command: {
          kind: "distill_build",
          cwd: flags.cwd || undefined,
          limit: flags.limit || undefined,
          budget: flags.budget || undefined,
          providers: flags.providers.length > 0 ? flags.providers : undefined,
          dryRun: true,
        },
      };
    }
    if (sub === "load") {
      // :distill load [path] [--cwd /project/path]
      const { flags, remaining } = parseDistillFlags(parts.slice(1));
      const explicitPath = remaining.join(" ").trim() || undefined;
      return {
        command: {
          kind: "distill_load",
          path: explicitPath,
          cwd: flags.cwd || undefined,
        },
      };
    }
    if (sub === "unload") {
      return { command: { kind: "distill_unload" } };
    }
    return { command: { kind: "help" } };
  }

  if (head === "brain") {
    const sub = (parts[0] || "").toLowerCase();
    if (sub === "disconnect") return { command: { kind: "brain_disconnect" } };
    if (sub === "status") return { command: { kind: "brain_status" } };
    if (sub === "replay") {
      const sessionId = (parts[1] || "").trim();
      if (!sessionId) return { command: { kind: "help" } };
      return { command: { kind: "brain_replay", sessionId } };
    }
    if (sub === "connect") {
      const urlRaw = (parts[1] || "").trim();
      if (!urlRaw) return { command: { kind: "help" } };
      let url: URL;
      try {
        url = new URL(urlRaw);
      } catch {
        return { command: { kind: "help" } };
      }
      if (url.protocol !== "ws:" && url.protocol !== "wss:") return { command: { kind: "help" } };

      const provider = (parts[2] || "").toLowerCase() as ProviderName;
      const providerValue =
        provider === "claude" || provider === "codex" || provider === "gemini" || provider === "mock"
          ? provider
          : undefined;
      const sessionId = (parts[3] || "").trim() || undefined;
      return { command: { kind: "brain_connect", url: url.toString(), provider: providerValue, sessionId } };
    }
    return { command: { kind: "help" } };
  }

  return { command: { kind: "help" } };
}
