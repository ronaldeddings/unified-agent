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
  | { kind: "brain_replay"; sessionId: string };

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
