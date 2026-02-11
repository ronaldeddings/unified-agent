import { toOneLine } from "./stream";

export function summarizeToolInput(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;
  const parts: string[] = [];

  pushIf(parts, "cmd", o.command);
  pushIf(parts, "desc", o.description);
  pushIf(parts, "file", o.file_path ?? o.path ?? o.target_file ?? o.target_path);
  pushIf(parts, "dir", o.dir_path ?? o.directory);
  pushIf(parts, "query", o.query);
  pushIf(parts, "url", o.url);
  pushIf(parts, "cwd", o.cwd);

  if (parts.length === 0) {
    const keys = Object.keys(o).slice(0, 3);
    for (const k of keys) pushIf(parts, k, o[k]);
  }

  return parts.join(" ");
}

export function summarizeToolOutput(output: unknown): string {
  if (typeof output === "string") return compactText(output);
  if (!output || typeof output !== "object") return "";
  const o = output as Record<string, unknown>;

  const parts: string[] = [];
  pushIf(parts, "stdout", o.stdout);
  pushIf(parts, "stderr", o.stderr);
  pushIf(parts, "output", o.output);
  pushIf(parts, "exit", o.exit_code);
  pushIf(parts, "status", o.status);

  if (parts.length > 0) return parts.join(" ");
  return compactText(JSON.stringify(o));
}

export function summarizeCommandOutput(s: string): string {
  return compactText(s);
}

export function isMcpToolName(name: string): boolean {
  const v = name.toLowerCase();
  return v.startsWith("mcp__") || v.includes("mcp");
}

function pushIf(parts: string[], label: string, value: unknown): void {
  const v = formatValue(value);
  if (!v) return;
  parts.push(`${label}=${v}`);
}

function formatValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return quoteShort(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    const preview = value.slice(0, 3).map((v) => formatValue(v)).filter(Boolean).join(",");
    return quoteShort(preview);
  }
  if (typeof value === "object") {
    return quoteShort(JSON.stringify(value));
  }
  return "";
}

function quoteShort(v: string): string {
  const cleaned = compactText(v);
  return `"${cleaned}"`;
}

function compactText(v: string): string {
  return toOneLine(v.replace(/\u001b\[[0-9;]*m/g, ""), 140);
}

