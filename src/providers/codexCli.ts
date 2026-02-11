import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Provider, ProviderResponse } from "./types";
import { runStreamingCommand, safeJsonParse, toOneLine } from "./stream";
import { isMcpToolName, summarizeCommandOutput, summarizeToolInput } from "./telemetry";

export class CodexCliProvider implements Provider {
  name = "codex" as const;

  async ask(prompt: string, opts: { cwd: string; model?: string }): Promise<ProviderResponse> {
    const tmp = await mkdtemp(join(tmpdir(), "pai-ut-"));
    const outPath = join(tmp, "last.txt");

    const args = buildCodexArgs(outPath, prompt, opts.model);

    const { stderr, code } = await runStreamingCommand("codex", args, opts.cwd, {
      onStdoutLine: (line) => {
        const obj = safeJsonParse(line);
        if (!obj) return;

        if (obj.type === "thread.started") {
          console.log(`[codex] session ${obj.thread_id || "started"}`);
          return;
        }
        if (obj.type === "turn.started") {
          console.log("[codex] thinking");
          return;
        }
        if (obj.type === "item.started" && obj.item?.type === "command_execution") {
          const cmd = toOneLine(obj.item?.command || "command", 180);
          console.log(`[codex] run ${cmd}`);
          return;
        }
        if (obj.type === "item.completed" && obj.item?.type === "command_execution") {
          const exit = obj.item?.exit_code;
          const cmd = toOneLine(obj.item?.command || "command", 120);
          const out = summarizeCommandOutput(obj.item?.aggregated_output || "");
          const suffix = out ? ` output="${out}"` : "";
          console.log(`[codex] done exit=${exit ?? "?"} cmd="${cmd}"${suffix}`);
          return;
        }
        if (obj.type === "item.completed" && obj.item?.type === "reasoning") {
          console.log(`[codex] ${toOneLine(obj.item?.text || "reasoning")}`);
          return;
        }
        if (obj.type === "item.started" && obj.item?.type === "function_call") {
          const name = obj.item?.name || "tool";
          const details = summarizeToolInput(obj.item?.arguments || obj.item?.input);
          const prefix = isMcpToolName(name) ? "mcp" : "tool";
          console.log(`[codex] ${prefix} ${name}${details ? ` ${details}` : ""}`);
          return;
        }
        if (obj.type === "item.completed" && obj.item?.type === "function_call") {
          const name = obj.item?.name || "tool";
          const prefix = isMcpToolName(name) ? "mcp" : "tool";
          console.log(`[codex] ${prefix} done ${name}`);
          return;
        }
        if (obj.type === "item.started" && typeof obj.item?.type === "string") {
          const t = obj.item.type;
          if (t.includes("mcp")) {
            console.log(`[codex] mcp event start type=${t}`);
            return;
          }
        }
        if (obj.type === "item.completed" && typeof obj.item?.type === "string") {
          const t = obj.item.type;
          if (t.includes("mcp")) {
            console.log(`[codex] mcp event done type=${t}`);
            return;
          }
        }
        if (obj.type === "turn.completed" && obj.usage) {
          const inTok = obj.usage.input_tokens ?? 0;
          const outTok = obj.usage.output_tokens ?? 0;
          const cached = obj.usage.cached_input_tokens ?? 0;
          console.log(`[codex] usage in=${inTok} out=${outTok} cached=${cached}`);
          return;
        }
      },
      onStderrLine: (line) => {
        // Known noisy rollout warnings in some local codex states.
        if (line.includes("rollout::list: state db missing rollout path")) return;
        const msg = toOneLine(line);
        if (!msg) return;
        console.log(`[codex] ${msg}`);
      },
    });
    try {
      if (code !== 0) {
        throw new Error(`codex failed (${code}): ${stderr.trim()}`);
      }
      const text = (await readFile(outPath, "utf-8")).trim();
      return { text, raw: { stderr } };
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }
}

export function buildCodexArgs(outPath: string, prompt: string, model?: string): string[] {
  const args = [
    "exec",
    "--skip-git-repo-check",
    "--output-last-message",
    outPath,
    "--json",
    // Enforce YOLO mode for delegated Codex calls.
    "--dangerously-bypass-approvals-and-sandbox",
  ];
  if (model) args.push("--model", model);
  args.push(prompt);
  return args;
}
