export interface NormalizedEvent {
  type: "auth_status" | "tool_progress" | "tool_use_summary" | "stream_event" | "update_environment_variables";
  payload: Record<string, unknown>;
}

export function normalizeClaudeEvent(input: unknown): NormalizedEvent[] {
  const out: NormalizedEvent[] = [];
  if (!input || typeof input !== "object") return out;
  const o = input as Record<string, unknown>;

  if (o.type === "system" && o.subtype === "init") {
    out.push({
      type: "auth_status",
      payload: { status: "ok", model: o.model || null },
    });
  }

  if (o.type === "assistant") {
    out.push({ type: "stream_event", payload: { source: "claude", event: o } });
  }

  if (o.type === "user" && o.tool_use_result !== undefined) {
    out.push({
      type: "tool_use_summary",
      payload: {
        source: "claude",
        tool_use_result: o.tool_use_result,
      },
    });
  }

  return out;
}

export function normalizeCodexEvent(input: unknown): NormalizedEvent[] {
  const out: NormalizedEvent[] = [];
  if (!input || typeof input !== "object") return out;
  const o = input as Record<string, unknown>;

  if (o.type === "thread.started") {
    out.push({
      type: "auth_status",
      payload: { status: "ok", thread_id: o.thread_id || null },
    });
  }
  if (o.type === "item.started" || o.type === "item.completed") {
    out.push({
      type: "tool_progress",
      payload: { source: "codex", event: o.type, itemType: (o.item as any)?.type || null },
    });
  }
  if (o.type === "turn.completed") {
    out.push({
      type: "tool_use_summary",
      payload: { source: "codex", usage: o.usage || null },
    });
  }
  return out;
}

export function normalizeGeminiEvent(input: unknown): NormalizedEvent[] {
  const out: NormalizedEvent[] = [];
  if (!input || typeof input !== "object") return out;
  const o = input as Record<string, unknown>;

  if (o.type === "init") {
    out.push({
      type: "auth_status",
      payload: { status: "ok", model: o.model || null },
    });
  }
  if (o.type === "tool_call" || o.type === "tool_result" || o.type === "tool_use") {
    out.push({
      type: "tool_progress",
      payload: { source: "gemini", event: o.type, name: o.name || o.tool_name || null },
    });
  }
  if (o.type === "result") {
    out.push({
      type: "tool_use_summary",
      payload: { source: "gemini", status: o.status || null, stats: o.stats || null },
    });
  }
  return out;
}

export function normalizeEnvironmentUpdate(variables: Record<string, string>): NormalizedEvent {
  return {
    type: "update_environment_variables",
    payload: {
      keys: Object.keys(variables),
      count: Object.keys(variables).length,
    },
  };
}
