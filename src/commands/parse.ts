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
  | { kind: "distill_run"; sessionIds?: string[]; providers?: string[] }
  | { kind: "distill_seed"; platform: string; sessionId?: string }
  | { kind: "distill_ask"; question: string; platform?: string; providers?: string[] }
  | { kind: "distill_query"; query: string }
  | { kind: "distill_report"; sessionId?: string }
  | { kind: "distill_assess"; chunkId?: string }
  | { kind: "distill_status" }
  | { kind: "distill_watch"; enabled: boolean };

/**
 * Parse `:distill ask` arguments: quoted question string + optional flags.
 * Supports: "question" --platform claude --providers claude,codex,gemini
 */
function parseAskArgs(argStr: string): { question: string; flags: { platform: string; providers: string[] } } {
  const flags = { platform: "", providers: [] as string[] };
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

  // Parse flags from remainder
  const flagParts = remainder.split(/\s+/);
  for (let i = 0; i < flagParts.length; i++) {
    if (flagParts[i] === "--platform" && flagParts[i + 1]) {
      flags.platform = flagParts[i + 1].toLowerCase();
      i++;
    } else if (flagParts[i] === "--providers" && flagParts[i + 1]) {
      flags.providers = flagParts[i + 1].split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
      i++;
    }
  }

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
      const sessionIds: string[] = [];
      const providers: string[] = [];
      for (let i = 1; i < parts.length; i++) {
        if (parts[i] === "--providers" && parts[i + 1]) {
          providers.push(...parts[i + 1].split(",").map((s) => s.trim()).filter(Boolean));
          i++;
        } else {
          sessionIds.push(parts[i]);
        }
      }
      return {
        command: {
          kind: "distill_run",
          sessionIds: sessionIds.length > 0 ? sessionIds : undefined,
          providers: providers.length > 0 ? providers : undefined,
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
        },
      };
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
