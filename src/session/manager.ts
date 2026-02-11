import { cwd as nodeCwd } from "node:process";
import type { CanonicalEvent, MetaSession, ProviderName } from "./types";
import { newMetaSessionId } from "../util/ids";
import { appendEventJsonl } from "../storage/jsonl";
import { SessionDb } from "../storage/sqlite";

export class SessionManager {
  private db: SessionDb;
  private session: MetaSession | null = null;

  constructor(db = new SessionDb()) {
    this.db = db;
  }

  close(): void {
    this.db.close();
  }

  getCurrent(): MetaSession | null {
    return this.session;
  }

  async newSession(args: { project?: string; cwd?: string; provider?: ProviderName; model?: string }): Promise<MetaSession> {
    const cwd = args.cwd || nodeCwd();
    const project = args.project?.trim() || "default";
    const now = Date.now();
    const id = newMetaSessionId(now);
    const model = (args.model || "").trim() || undefined;
    const s: MetaSession = {
      id,
      project,
      cwd,
      createdAtEpoch: now,
      activeProvider: args.provider || "mock",
      activeModel: model,
    };
    this.db.createMetaSession(s);
    this.session = s;

    await this.recordEvent({
      v: 1,
      ts: new Date(now).toISOString(),
      metaSessionId: s.id,
      project: s.project,
      cwd: s.cwd,
      provider: s.activeProvider,
      type: "meta_session_created",
      text: `created meta-session ${s.id}`,
    });
    return s;
  }

  async resume(metaSessionId: string): Promise<MetaSession> {
    const s = this.db.getMetaSession(metaSessionId);
    if (!s) throw new Error(`unknown meta-session: ${metaSessionId}`);
    this.session = s;

    await this.recordEvent({
      v: 1,
      ts: new Date().toISOString(),
      metaSessionId: s.id,
      project: s.project,
      cwd: s.cwd,
      provider: s.activeProvider,
      type: "meta_session_resumed",
      text: `resumed meta-session ${s.id}`,
    });
    return s;
  }

  list(limit = 20): MetaSession[] {
    return this.db.listMetaSessions(limit);
  }

  getConversationHistory(limit = 50): CanonicalEvent[] {
    if (!this.session) throw new Error("no active meta-session");
    return this.db
      .getRecentEvents(this.session.id, limit)
      .reverse()
      .filter((e) => e.type === "user_message" || e.type === "assistant_message");
  }

  async setProvider(provider: ProviderName): Promise<void> {
    if (!this.session) throw new Error("no active meta-session");
    this.session.activeProvider = provider;
    this.db.updateActiveProvider(this.session.id, provider);
    await this.recordEvent({
      v: 1,
      ts: new Date().toISOString(),
      metaSessionId: this.session.id,
      project: this.session.project,
      cwd: this.session.cwd,
      provider,
      type: "provider_switched",
      text: `active provider: ${provider}`,
    });
  }

  async setModel(model?: string): Promise<void> {
    if (!this.session) throw new Error("no active meta-session");
    const normalized = (model || "").trim() || undefined;
    this.session.activeModel = normalized;
    this.db.updateActiveModel(this.session.id, normalized);
    await this.recordEvent({
      v: 1,
      ts: new Date().toISOString(),
      metaSessionId: this.session.id,
      project: this.session.project,
      cwd: this.session.cwd,
      provider: this.session.activeProvider,
      type: "model_switched",
      text: normalized ? `active model: ${normalized}` : "active model: (provider default)",
    });
  }

  async recordUser(text: string): Promise<void> {
    if (!this.session) throw new Error("no active meta-session");
    await this.recordEvent(this.makeTextEvent("user_message", text));
  }

  async recordAssistant(text: string): Promise<void> {
    if (!this.session) throw new Error("no active meta-session");
    await this.recordEvent(this.makeTextEvent("assistant_message", text));
  }

  async recordMemoryInjected(text: string): Promise<void> {
    if (!this.session) throw new Error("no active meta-session");
    await this.recordEvent(this.makeTextEvent("memory_injected", text));
  }

  async recordError(text: string): Promise<void> {
    if (!this.session) throw new Error("no active meta-session");
    await this.recordEvent(this.makeTextEvent("error", text));
  }

  private makeTextEvent(type: CanonicalEvent["type"], text: string): CanonicalEvent {
    if (!this.session) throw new Error("no active meta-session");
    return {
      v: 1,
      ts: new Date().toISOString(),
      metaSessionId: this.session.id,
      project: this.session.project,
      cwd: this.session.cwd,
      provider: this.session.activeProvider,
      type,
      text,
    };
  }

  private async recordEvent(e: CanonicalEvent): Promise<void> {
    this.db.insertEvent(e);
    await appendEventJsonl(e.metaSessionId, e);
  }
}
