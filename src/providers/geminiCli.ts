import type { Provider, ProviderResponse } from "./types";
import { runStreamingCommand, safeJsonParse, toOneLine } from "./stream";
import { isMcpToolName, summarizeToolInput, summarizeToolOutput } from "./telemetry";

const DEFAULT_GEMINI_FALLBACKS = ["gemini-3-flash-preview", "gemini-2.5-flash", "gemini-2.5-pro", "auto"];

export class GeminiCliProvider implements Provider {
  name = "gemini" as const;

  async ask(prompt: string, opts: { cwd: string; model?: string }): Promise<ProviderResponse> {
    const models = buildGeminiModelCandidates(opts.model, process.env.UNIFIED_AGENT_GEMINI_MODELS);
    let lastError = "";

    for (let i = 0; i < models.length; i += 1) {
      const model = models[i];
      const label = model || "auto";
      if (models.length > 1) {
        console.log(`[gemini] trying model=${label} (${i + 1}/${models.length})`);
      }

      try {
        const res = await runGeminiOnce(prompt, opts.cwd, model);
        if (models.length > 1 && i > 0) {
          console.log(`[gemini] model fallback succeeded with ${label}`);
        }
        return { text: res.text, raw: { stderr: res.stderr, model: label } };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        lastError = msg;
        const canFallback = i < models.length - 1 && isGeminiFallbackEligibleError(msg);
        if (canFallback) {
          console.log(`[gemini] fallback after error: ${toOneLine(msg)}`);
          continue;
        }
        throw e;
      }
    }

    throw new Error(lastError || "gemini failed without assistant output");
  }
}

export function buildGeminiArgs(prompt: string, model?: string): string[] {
  const args = [
    "-p",
    prompt,
    "--output-format",
    "stream-json",
    // Enforce YOLO mode for delegated Gemini calls.
    "--yolo",
  ];
  if (model && model !== "auto") args.unshift("--model", model);
  return args;
}

export function buildGeminiModelCandidates(model?: string, envFallbacks?: string): Array<string | undefined> {
  const out: Array<string | undefined> = [];
  const seen = new Set<string>();

  const add = (v?: string) => {
    const normalized = normalizeModel(v);
    const key = normalized || "__AUTO__";
    if (seen.has(key)) return;
    seen.add(key);
    out.push(normalized);
  };

  if ((model || "").trim()) add(model);

  const envValues =
    (envFallbacks || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean) || [];
  const values = envValues.length > 0 ? envValues : DEFAULT_GEMINI_FALLBACKS;
  for (const v of values) add(v);

  // Guarantee at least one candidate.
  if (out.length === 0) add(undefined);
  return out;
}

function normalizeModel(v?: string): string | undefined {
  const t = (v || "").trim();
  if (!t) return undefined;
  if (t.toLowerCase() === "auto" || t.toLowerCase() === "default") return undefined;
  return t;
}

export function isGeminiFallbackEligibleError(s: string): boolean {
  const v = s.toLowerCase();
  return (
    v.includes("no capacity available for model") ||
    v.includes("model_capacity_exhausted") ||
    v.includes("resource_exhausted") ||
    v.includes("retryablequotaerror") ||
    v.includes("rate limit") ||
    v.includes("ratelimit") ||
    v.includes("status 429")
  );
}

async function runGeminiOnce(prompt: string, cwd: string, model?: string): Promise<{ text: string; stderr: string }> {
  const args = buildGeminiArgs(prompt, model);
  let hadFailure = false;
  let failureSummary = "";
  let finalText = "";
  let sawAssistantDelta = false;
  const { stdout, stderr, code } = await runStreamingCommand("gemini", args, cwd, {
    onStdoutLine: (line) => {
      const obj = safeJsonParse(line);
      if (obj) {
        if (obj.type === "init") {
          const chosen = obj.model || "unknown";
          console.log(`[gemini] model=${chosen}`);
          return;
        }
        if (obj.type === "tool_call") {
          const name = obj.name || obj.tool || "tool";
          const details = summarizeToolInput(obj.input || obj.args || obj.parameters);
          const prefix = isMcpToolName(name) ? "mcp" : "tool";
          console.log(`[gemini] ${prefix} ${name}${details ? ` ${details}` : ""}`);
          return;
        }
        if (obj.type === "tool_use") {
          const name = obj.tool_name || obj.name || "tool";
          const details = summarizeToolInput(obj.parameters || obj.input || obj.args);
          const prefix = isMcpToolName(name) ? "mcp" : "tool";
          console.log(`[gemini] ${prefix} ${name}${details ? ` ${details}` : ""}`);
          return;
        }
        if (obj.type === "tool_result") {
          const status = obj.status || "unknown";
          const details = summarizeToolOutput(obj.output);
          console.log(`[gemini] tool result ${status}${details ? ` ${details}` : ""}`);
          return;
        }
        if (obj.type === "message" && obj.role === "assistant" && typeof obj.content === "string") {
          if (obj.delta === true) {
            sawAssistantDelta = true;
            finalText += obj.content;
          } else {
            finalText = obj.content;
          }
          return;
        }
        if (obj.type === "result" && obj.status === "error") {
          hadFailure = true;
          if (typeof obj.error?.message === "string" && obj.error.message.trim()) {
            failureSummary = toOneLine(obj.error.message);
            console.log(`[gemini] ${failureSummary}`);
          }
          return;
        }
        if (obj.type === "result" && obj.status === "success" && obj.stats) {
          const inTok = obj.stats.input_tokens ?? obj.stats.input ?? 0;
          const outTok = obj.stats.output_tokens ?? 0;
          const calls = obj.stats.tool_calls ?? 0;
          console.log(`[gemini] usage in=${inTok} out=${outTok} tools=${calls}`);
        }
        if (obj.type === "result" && typeof obj.result === "string" && !sawAssistantDelta) {
          finalText = obj.result;
          return;
        }
        return;
      }

      const t = line.trim();
      if (!t) return;

      // Keep Gemini streaming concise: show only progress/error headlines.
      if (t.startsWith("Attempt ")) {
        console.log(`[gemini] ${toOneLine(t)}`);
        return;
      }
      if (t.startsWith("Created execution plan for ")) {
        console.log(`[gemini] ${toOneLine(t)}`);
        return;
      }
      if (t.startsWith("Expanding hook command: ")) {
        console.log(`[gemini] ${toOneLine(t)}`);
        return;
      }
      if (t.startsWith("Hook execution for ")) {
        console.log(`[gemini] ${toOneLine(t)}`);
        return;
      }
      if (t.startsWith("Error when talking to Gemini API")) {
        hadFailure = true;
        failureSummary = toOneLine(t);
        console.log(`[gemini] ${failureSummary}`);
        return;
      }
      if (t.includes("Max attempts reached")) {
        hadFailure = true;
        failureSummary = toOneLine(t);
        console.log(`[gemini] ${failureSummary}`);
        return;
      }
    },
    onStderrLine: (line) => {
      const t = line.trim();
      if (!t) return;
      // Avoid stack dump noise; keep high-level stderr only.
      if (t.startsWith("Error:") || t.startsWith("ERR")) {
        const msg = toOneLine(t);
        console.log(`[gemini] ${msg}`);
      }
    },
  });

  const trimmedText = finalText.trim();
  if (code !== 0 || (hadFailure && !trimmedText)) {
    const summary = pickGeminiErrorSummary(stdout, stderr, failureSummary, code);
    throw new Error(summary);
  }

  const text = trimmedText || extractAssistantTextFromStdout(stdout);
  if (!text) {
    throw new Error("gemini failed without assistant output");
  }
  return { text, stderr };
}

function pickGeminiErrorSummary(stdout: string, stderr: string, failureSummary: string, code: number): string {
  const firstStdErr = stderr.split("\n").map((s) => s.trim()).find(Boolean) || "";
  const firstStdOut = stdout.split("\n").map((s) => s.trim()).find(Boolean) || "";
  let resultError = "";
  for (const line of stdout.split("\n")) {
    const obj = safeJsonParse(line);
    if (obj && obj.type === "result" && obj.status === "error" && typeof obj.error?.message === "string") {
      resultError = obj.error.message;
      break;
    }
  }
  const capacityLine =
    stdout
      .split("\n")
      .map((s) => s.trim())
      .find((s) => s.includes("No capacity available for model")) || "";
  const apiLine =
    stdout
      .split("\n")
      .map((s) => s.trim())
      .find((s) => s.startsWith("Error when talking to Gemini API")) || "";
  const summary = toOneLine(resultError || failureSummary || capacityLine || apiLine || firstStdErr || firstStdOut || "unknown error");
  return `gemini failed (${code}): ${summary}`;
}

function extractAssistantTextFromStdout(stdout: string): string {
  const lines = stdout.split("\n");

  // Prefer structured assistant messages.
  for (const line of lines) {
    const obj = safeJsonParse(line);
    if (obj && obj.type === "message" && obj.role === "assistant" && typeof obj.content === "string") {
      const v = obj.content.trim();
      if (v) return v;
    }
    if (obj && obj.type === "result" && typeof obj.result === "string") {
      const v = obj.result.trim();
      if (v) return v;
    }
  }

  // Fallback: last non-empty non-noisy line.
  const filtered = lines
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .filter((l) => !l.startsWith("🤖 "))
    .filter((l) => !l.startsWith("[CONTEXT INJECTION]"))
    .filter((l) => !l.startsWith("Hook "))
    .filter((l) => !l.startsWith("[WARN]"))
    .filter((l) => !l.startsWith("Warning:"));

  return filtered.at(-1) || "";
}
