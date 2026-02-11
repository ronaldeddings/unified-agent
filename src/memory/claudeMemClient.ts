import { basename } from "node:path";

export interface ClaudeMemSearchResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export class ClaudeMemClient {
  constructor(
    private baseUrl = "http://127.0.0.1:37777",
    private fetchImpl: typeof fetch = fetch
  ) {}

  async health(): Promise<boolean> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/api/health`);
      return res.ok;
    } catch {
      return false;
    }
  }

  async contextInject(project: string): Promise<string | null> {
    const url = `${this.baseUrl}/api/context/inject?project=${encodeURIComponent(project)}&colors=false`;
    const res = await this.fetchImpl(url);
    if (!res.ok) return null;
    return await res.text();
  }

  async search(query: string, project?: string, limit = 10): Promise<ClaudeMemSearchResult> {
    const params = new URLSearchParams();
    params.set("query", query);
    params.set("limit", String(limit));
    if (project) params.set("project", project);
    const res = await this.fetchImpl(`${this.baseUrl}/api/search?${params.toString()}`);
    if (!res.ok) {
      return { content: [{ type: "text", text: `claude-mem search failed: ${res.status}` }], isError: true };
    }
    return (await res.json()) as ClaudeMemSearchResult;
  }

  async stats(): Promise<unknown | null> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/stats`);
    if (!res.ok) return null;
    return await res.json();
  }

  // Minimal write path: store tool usage as an observation (matches claude-mem hook shape).
  async storeObservation(args: {
    contentSessionId: string;
    cwd: string;
    tool_name: string;
    tool_input: unknown;
    tool_response: unknown;
  }): Promise<boolean> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/sessions/observations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args),
    });
    return res.ok;
  }

  static defaultProjectFromCwd(cwd: string): string {
    return basename(cwd);
  }
}
