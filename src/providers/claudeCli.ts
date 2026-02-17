import type { PermissionMode, Provider, ProviderAskOptions, ProviderResponse } from "./types";
import { runStreamingCommand, safeJsonParse, toOneLine } from "./stream";
import { isMcpToolName, summarizeToolInput, summarizeToolOutput } from "./telemetry";

export class ClaudeCliProvider implements Provider {
  name = "claude" as const;
  capabilities = {
    supportsSdkUrl: true,
    supportsSetModel: true,
    supportsPermissionMode: true,
  };

  async ask(prompt: string, opts: ProviderAskOptions): Promise<ProviderResponse> {
    const args = buildClaudeArgs(prompt, opts);

    let finalText = "";
    const { stdout, stderr, code } = await runStreamingCommand("claude", args, opts.cwd, {
      signal: opts.signal,
      onStdoutLine: (line) => {
        const obj = safeJsonParse(line);
        if (!obj) return;

        // Stream concise lifecycle + tool info.
        if (obj.type === "system" && obj.subtype === "hook_started") {
          const name = obj.hook_name || "hook";
          console.log(`[claude] hook start ${name}`);
          return;
        }
        if (obj.type === "system" && obj.subtype === "hook_response") {
          const name = obj.hook_name || "hook";
          const outcome = obj.outcome || "unknown";
          const stderr = typeof obj.stderr === "string" ? toOneLine(obj.stderr) : "";
          console.log(`[claude] hook ${outcome} ${name}${stderr ? ` stderr="${stderr}"` : ""}`);
          return;
        }

        if (obj.type === "system" && obj.subtype === "init") {
          const model = obj.model || "unknown";
          console.log(`[claude] model=${model}`);
          if (Array.isArray(obj.mcp_servers)) {
            const connected = obj.mcp_servers
              .filter((s: any) => s?.status === "connected")
              .map((s: any) => s?.name)
              .filter(Boolean);
            const failed = obj.mcp_servers
              .filter((s: any) => s?.status !== "connected")
              .map((s: any) => s?.name)
              .filter(Boolean);
            if (connected.length > 0) console.log(`[claude] mcp connected=${connected.join(",")}`);
            if (failed.length > 0) console.log(`[claude] mcp unavailable=${failed.join(",")}`);
          }
          return;
        }

        if (obj.type === "assistant" && Array.isArray(obj.message?.content)) {
          const textBlocks = obj.message.content
            .filter((b: any) => b?.type === "text" && typeof b.text === "string")
            .map((b: any) => b.text);
          if (textBlocks.length > 0) finalText = textBlocks.join("\n").trim();

          const toolBlocks = obj.message.content.filter((b: any) => b?.type === "tool_use");
          for (const t of toolBlocks) {
            const name = t?.name || "tool";
            const details = summarizeToolInput(t?.input);
            const prefix = isMcpToolName(name) ? "mcp" : "tool";
            console.log(`[claude] ${prefix} ${name}${details ? ` ${details}` : ""}`);
          }
          return;
        }

        if (obj.type === "user" && Array.isArray(obj.message?.content)) {
          const resultBlocks = obj.message.content.filter((b: any) => b?.type === "tool_result");
          for (const r of resultBlocks) {
            const status = r?.is_error ? "error" : "ok";
            const details = summarizeToolOutput(r?.content);
            console.log(`[claude] tool result ${status}${details ? ` ${details}` : ""}`);
          }
          if (obj.tool_use_result) {
            const details = summarizeToolOutput(obj.tool_use_result);
            if (details) console.log(`[claude] tool io ${details}`);
          }
          return;
        }

        if (obj.type === "result") {
          if (typeof obj.result === "string") {
            finalText = obj.result.trim();
          }
          const usage = obj.usage;
          if (usage && typeof usage === "object") {
            const inTok = usage.input_tokens ?? 0;
            const outTok = usage.output_tokens ?? 0;
            const cached = usage.cache_read_input_tokens ?? 0;
            console.log(`[claude] usage in=${inTok} out=${outTok} cached=${cached}`);
          }
          return;
        }
      },
      onStderrLine: (line) => {
        const msg = toOneLine(line);
        if (!msg) return;
        console.log(`[claude] ${msg}`);
      },
    });
    if (code !== 0) {
      throw new Error(`claude failed (${code}): ${stderr.trim() || stdout.trim()}`);
    }

    const text = finalText || stdout.trim();
    return { text, raw: { stderr } };
  }
}

export function buildClaudeArgs(prompt: string, opts: {
  model?: string;
  sdkUrl?: string;
  permissionMode?: PermissionMode;
  maxThinkingTokens?: number;
  resumePath?: string;
} = {}): string[] {
  const shouldBypassPermissions = resolveBypassPermissions(opts.permissionMode, opts.sdkUrl);
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
  ];
  if (shouldBypassPermissions) {
    // Preserve existing delegated behavior unless explicitly overridden.
    args.push("--dangerously-skip-permissions");
  }
  if (opts.model) args.push("--model", opts.model);
  if (opts.maxThinkingTokens !== undefined && opts.maxThinkingTokens !== null) {
    args.push("--max-thinking-tokens", String(opts.maxThinkingTokens));
  }
  if (opts.sdkUrl) args.push("--sdk-url", opts.sdkUrl);
  if (opts.resumePath) args.push("--resume", opts.resumePath);
  args.push(prompt);
  return args;
}

function resolveBypassPermissions(permissionMode?: PermissionMode, sdkUrl?: string): boolean {
  if (permissionMode === "bypassPermissions") return true;
  if (permissionMode === "default" || permissionMode === "acceptEdits" || permissionMode === "plan") {
    return false;
  }
  // Keep historical unsafe default for local delegated mode only.
  return !sdkUrl;
}
