import { spawn } from "node:child_process";

export interface StreamRunOptions {
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
  signal?: AbortSignal;
}

export interface StreamRunResult {
  stdout: string;
  stderr: string;
  code: number;
}

export function runStreamingCommand(
  cmd: string,
  args: string[],
  cwd: string,
  opts: StreamRunOptions = {}
): Promise<StreamRunResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const onAbort = () => {
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    let stdout = "";
    let stderr = "";
    let outBuf = "";
    let errBuf = "";

    const flushLines = (buf: string, cb?: (line: string) => void): string => {
      let idx = buf.indexOf("\n");
      while (idx >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, "");
        cb?.(line);
        buf = buf.slice(idx + 1);
        idx = buf.indexOf("\n");
      }
      return buf;
    };

    child.stdout.on("data", (d) => {
      const chunk = d.toString("utf-8");
      stdout += chunk;
      outBuf += chunk;
      outBuf = flushLines(outBuf, opts.onStdoutLine);
    });

    child.stderr.on("data", (d) => {
      const chunk = d.toString("utf-8");
      stderr += chunk;
      errBuf += chunk;
      errBuf = flushLines(errBuf, opts.onStderrLine);
    });

    child.on("close", (code) => {
      opts.signal?.removeEventListener("abort", onAbort);
      if (outBuf.length > 0) opts.onStdoutLine?.(outBuf.replace(/\r$/, ""));
      if (errBuf.length > 0) opts.onStderrLine?.(errBuf.replace(/\r$/, ""));
      resolve({ stdout, stderr, code: code ?? 1 });
    });
  });
}

export function toOneLine(s: string, max = 140): string {
  const v = s.replace(/\s+/g, " ").trim();
  if (v.length <= max) return v;
  return `${v.slice(0, max - 1)}…`;
}

export function safeJsonParse(line: string): any | null {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}
