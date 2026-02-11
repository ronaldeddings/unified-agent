#!/usr/bin/env bun
import { BrainGatewayServer } from "../src/gateway/wsServer";

async function runCmd(
  label: string,
  args: string[],
  env: Record<string, string>,
  mustContain: string,
  timeoutMs = 90_000
): Promise<{ label: string; ok: boolean; output: string }> {
  const proc = Bun.spawn({
    cmd: args,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  const outPromise = new Response(proc.stdout).text();
  const errPromise = new Response(proc.stderr).text();
  const exitPromise = proc.exited;

  const timeout = new Promise<number>((resolve) => {
    setTimeout(() => {
      try {
        proc.kill("SIGTERM");
      } catch {
        // ignore
      }
      resolve(124);
    }, timeoutMs);
  });

  const code = await Promise.race([exitPromise, timeout]);
  const out = await outPromise;
  const err = await errPromise;
  const combined = `${out}\n${err}`;
  const ok = code === 0 && combined.includes(mustContain);
  return {
    label,
    ok,
    output: combined.slice(0, 4000),
  };
}

async function main(): Promise<void> {
  const cwd = process.cwd();
  const server = new BrainGatewayServer();
  const started = server.start({ host: "127.0.0.1", port: 7799 });

  const baseArgs = ["bun", "run", "src/cli.ts", "--once"];
  const rows: Array<{ label: string; ok: boolean; output: string }> = [];

  rows.push(
    await runCmd(
      "delegated_claude",
      [...baseArgs, "--provider", "claude", "Output exactly: E2E_CLAUDE_OK"],
      { PWD: cwd },
      "E2E_CLAUDE_OK"
    )
  );

  rows.push(
    await runCmd(
      "delegated_codex",
      [...baseArgs, "--provider", "codex", "Output exactly: E2E_CODEX_OK"],
      { PWD: cwd },
      "E2E_CODEX_OK"
    )
  );

  rows.push(
    await runCmd(
      "delegated_gemini",
      [...baseArgs, "--provider", "gemini", "Output exactly: E2E_GEMINI_OK"],
      { PWD: cwd },
      "E2E_GEMINI_OK"
    )
  );

  rows.push(
    await runCmd(
      "brain_codex",
      [
        ...baseArgs,
        "--brain-url",
        `${started.url}/ws?sessionId=e2e_codex`,
        "--brain-provider",
        "codex",
        "Output exactly: E2E_BRAIN_CODEX_OK",
      ],
      { PWD: cwd, UNIFIED_AGENT_ALLOW_INSECURE_BRAIN: "1" },
      "E2E_BRAIN_CODEX_OK"
    )
  );

  rows.push(
    await runCmd(
      "brain_gemini",
      [
        ...baseArgs,
        "--brain-url",
        `${started.url}/ws?sessionId=e2e_gemini`,
        "--brain-provider",
        "gemini",
        "Output exactly: E2E_BRAIN_GEMINI_OK",
      ],
      { PWD: cwd, UNIFIED_AGENT_ALLOW_INSECURE_BRAIN: "1" },
      "E2E_BRAIN_GEMINI_OK"
    )
  );

  rows.push(
    await runCmd(
      "brain_claude",
      [
        ...baseArgs,
        "--brain-url",
        `${started.url}/ws?sessionId=e2e_claude`,
        "--brain-provider",
        "claude",
        "Output exactly: E2E_BRAIN_CLAUDE_OK",
      ],
      {
        PWD: cwd,
        UNIFIED_AGENT_ALLOW_INSECURE_BRAIN: "1",
      },
      "E2E_BRAIN_CLAUDE_OK"
    )
  );

  server.stop(true);

  console.log(
    JSON.stringify(
      {
        ok: rows.every((r) => r.ok),
        results: rows.map((r) => ({ label: r.label, ok: r.ok })),
      },
      null,
      2
    )
  );

  if (rows.some((r) => !r.ok)) {
    for (const row of rows.filter((r) => !r.ok)) {
      console.error(`FAILED: ${row.label}\n${row.output}`);
    }
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
