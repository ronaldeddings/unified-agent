import { getAdapter } from "../adapters";
import type { AdapterSessionContext } from "../adapters/base";
import type { SessionManager } from "../session/manager";
import type { ProviderName } from "../session/types";
import { newGatewaySessionId } from "../util/ids";
import { GatewayError, toControlError } from "./errors";
import { unsupportedSubtype } from "./compat";
import { OutboundQueue } from "./outboundQueue";
import { PendingPermissions } from "./pendingPermissions";
import {
  errorResponse,
  parseEnvelope,
  successResponse,
  type ControlSubtype,
  type UcpControlCancelRequest,
  type UcpControlRequest,
  type UcpEnvelope,
  type UcpUserMessage,
} from "./protocol";
import {
  GatewayRateLimiter,
  type GatewayPolicyConfig,
  enforcePayloadSize,
  validateCanUseToolDecision,
  validateBrainUrl,
} from "./policy";
import { ReplayBuffer } from "./replayBuffer";
import { SessionRegistry, type GatewaySessionState } from "./sessionRegistry";
import { GatewayMetrics } from "./metrics";
import { GatewayStateStore } from "./stateStore";

export interface GatewayRouterOptions {
  policy?: GatewayPolicyConfig;
  sessionManager?: SessionManager;
  registry?: SessionRegistry;
  metrics?: GatewayMetrics;
  stateStore?: GatewayStateStore;
}

export class GatewayRouter {
  readonly registry: SessionRegistry;
  private readonly sessionManager?: SessionManager;
  private readonly policy: GatewayPolicyConfig;
  private readonly rateLimiter: GatewayRateLimiter;
  private readonly metrics: GatewayMetrics;
  private readonly stateStore: GatewayStateStore;

  constructor(options: GatewayRouterOptions = {}) {
    this.registry = options.registry || new SessionRegistry();
    this.sessionManager = options.sessionManager;
    this.policy = options.policy || {};
    this.rateLimiter = new GatewayRateLimiter(this.policy.maxControlRequestsPerMinute || 240);
    this.metrics = options.metrics || new GatewayMetrics();
    this.stateStore = options.stateStore || new GatewayStateStore();
    for (const restored of this.stateStore.load()) {
      this.registry.upsert(restored);
    }
  }

  getMetricsSnapshot(): ReturnType<GatewayMetrics["snapshot"]> {
    return this.metrics.snapshot();
  }

  getMetricsPrometheus(): string {
    return this.metrics.toPrometheus();
  }

  getMetricsInstance(): GatewayMetrics {
    return this.metrics;
  }

  markSessionConnected(sessionId: string): void {
    const state = this.registry.get(sessionId);
    if (!state) return;
    state.connected = true;
    state.lastSeenEpoch = Date.now();
    this.persistState();
  }

  markSessionDisconnected(sessionId: string, reason = "backend disconnected"): UcpEnvelope[] {
    const state = this.registry.get(sessionId);
    if (!state) return [];
    state.connected = false;
    state.lastSeenEpoch = Date.now();
    const cancelled = state.pendingPermissions.cancelBySession(sessionId, reason);
    const out: UcpEnvelope[] = [
      {
        type: "transport_state",
        session_id: sessionId,
        state: "cli_disconnected",
      },
      ...cancelled,
    ];
    for (const e of out) state.replay.push(e);
    this.persistState();
    return out;
  }

  enqueueOutbound(sessionId: string, id: string, envelope: UcpEnvelope): void {
    const state = this.registry.get(sessionId);
    if (!state) return;
    state.outbound.enqueue(id, envelope);
    this.persistState();
  }

  async flushOutbound(sessionId: string, send: (event: UcpEnvelope) => Promise<void> | void): Promise<void> {
    const state = this.registry.get(sessionId);
    if (!state) return;
    await state.outbound.flush(send);
    this.persistState();
  }

  applyEnvironmentVariables(sessionId: string, variables: Record<string, string>): number {
    const state = this.registry.get(sessionId);
    if (!state) return 0;
    state.envVars = { ...(state.envVars || {}), ...variables };
    this.persistState();
    return Object.keys(variables).length;
  }

  async handleRaw(sessionId: string, raw: string): Promise<UcpEnvelope[]> {
    try {
      enforcePayloadSize(raw, this.policy);
      const parsed = parseEnvelope(raw);
      if (!parsed.ok) {
        if (parsed.error.startsWith("unsupported envelope.type:")) {
          // Claude sdk-url streams include additional envelope types (for example
          // result/auth_status/tool summaries) that this router may not actively
          // process. Ignore them instead of reflecting protocol errors.
          return [];
        }
        return [{ type: "error", code: "INVALID_ENVELOPE", message: parsed.error }];
      }
      return this.handleEnvelope(sessionId, parsed.value);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return [{ type: "error", code: "INTERNAL_ERROR", message }];
    }
  }

  async handleEnvelope(sessionId: string, envelope: UcpEnvelope): Promise<UcpEnvelope[]> {
    if (envelope.type === "control_request") {
      return this.handleControlRequest(sessionId, envelope);
    }
    if (envelope.type === "control_cancel_request") {
      return this.handleControlCancel(sessionId, envelope);
    }
    if (envelope.type === "user") {
      return this.handleUserMessage(sessionId, envelope);
    }
    if (envelope.type === "keep_alive") {
      const state = this.registry.get(sessionId);
      if (state) this.registry.touch(state.sessionId);
      this.persistState();
      return [];
    }
    if (envelope.type === "update_environment_variables") {
      const state = this.registry.get(sessionId);
      if (state) {
        state.envVars = { ...(state.envVars || {}), ...(envelope.variables || {}) };
      }
      this.persistState();
      return [
        {
          type: "system",
          subtype: "status",
          session_id: sessionId,
          payload: {
            updatedVariables: Object.keys(envelope.variables || {}).length,
          },
        },
      ];
    }
    if (
      envelope.type === "control_response" ||
      envelope.type === "assistant" ||
      envelope.type === "system" ||
      envelope.type === "transport_state" ||
      envelope.type === "permission_cancelled" ||
      envelope.type === "error"
    ) {
      const state = this.registry.get(sessionId);
      if (state) {
        state.replay.push(envelope);
        this.registry.touch(sessionId);
      }
      this.persistState();
      return [];
    }
    return [];
  }

  private async handleControlRequest(sessionId: string, envelope: UcpControlRequest): Promise<UcpEnvelope[]> {
    const startedAt = Date.now();
    if (!this.rateLimiter.accept(sessionId)) {
      return [errorResponse(envelope.request_id, "rate limit exceeded", "RATE_LIMITED")];
    }

    if (envelope.request.subtype === "initialize") {
      return this.handleInitialize(sessionId, envelope);
    }

    const state = this.registry.get(sessionId);
    if (!state) {
      return [errorResponse(envelope.request_id, "session not initialized", "NOT_INITIALIZED")];
    }

    state.pendingRequests.set(envelope.request_id, {
      requestId: envelope.request_id,
      subtype: envelope.request.subtype,
      startedAt: Date.now(),
    });

    try {
      const subtype = envelope.request.subtype;
      if (!state.adapter.capabilities.supportedControlSubtypes.has(subtype)) {
        this.metrics.unsupportedSubtype(state.provider, subtype);
        const unsupported = unsupportedSubtype(envelope.request_id, sessionId, state.provider, subtype);
        return [unsupported.warning, unsupported.response];
      }

      this.metrics.requestsTotal(state.provider, subtype);
      const responses = await this.dispatchControl(state, envelope);
      this.metrics.observeLatency("control_response_latency_ms", Date.now() - startedAt, {
        provider: state.provider,
        subtype,
      });
      state.pendingRequests.delete(envelope.request_id);
      for (const r of responses) state.replay.push(r);
      await this.persistControl(envelope, responses[0]);
      this.persistState();
      return responses;
    } catch (err) {
      state.pendingRequests.delete(envelope.request_id);
      this.persistState();
      return [toControlError(envelope.request_id, err)];
    }
  }

  private async handleInitialize(sessionId: string, envelope: UcpControlRequest): Promise<UcpEnvelope[]> {
    const req = envelope.request;
    if (req.subtype !== "initialize") {
      return [errorResponse(envelope.request_id, "internal initialize dispatch mismatch", "INTERNAL_ERROR")];
    }

    const provider = req.provider as ProviderName;
    const adapter = getAdapter(provider);

    const existing = this.registry.get(sessionId);
    if (existing?.brainUrl) {
      validateBrainUrl(existing.brainUrl, this.policy);
    }

    const state: GatewaySessionState = {
      sessionId,
      metaSessionId: sessionId,
      provider,
      cwd: process.cwd(),
      project: "default",
      model: req.model,
      permissionMode: "bypassPermissions",
      maxThinkingTokens: undefined,
      brainUrl: existing?.brainUrl,
      gatewaySessionId: req.gateway_session_id || existing?.gatewaySessionId || newGatewaySessionId(),
      providerSessionId: req.provider_session_id || existing?.providerSessionId,
      envVars: existing?.envVars || {},
      adapter,
      connected: true,
      lastSeenEpoch: Date.now(),
      replay: existing?.replay || new ReplayBuffer(1000),
      outbound: existing?.outbound || new OutboundQueue(),
      pendingPermissions: existing?.pendingPermissions || new PendingPermissions(),
      pendingRequests: existing?.pendingRequests || new Map(),
    };

    const init = await adapter.initialize(this.toAdapterContext(state));
    if (init.providerSessionId) state.providerSessionId = init.providerSessionId;
    this.registry.upsert(state);
    this.persistState();

    return [
      {
        type: "transport_state",
        session_id: sessionId,
        state: "cli_connected",
        payload: {
          provider,
          model: req.model,
          gatewaySessionId: state.gatewaySessionId,
          providerSessionId: state.providerSessionId,
          supportsSdkUrl: adapter.capabilities.supportsSdkUrl,
        },
      },
      successResponse(envelope.request_id, {
        provider,
        model: state.model,
        gatewaySessionId: state.gatewaySessionId,
        providerSessionId: state.providerSessionId,
        capabilities: [...adapter.capabilities.supportedControlSubtypes.values()],
        info: init.info,
      }),
    ];
  }

  private async dispatchControl(state: GatewaySessionState, envelope: UcpControlRequest): Promise<UcpEnvelope[]> {
    const reqId = envelope.request_id;
    const req = envelope.request;
    const subtype = req.subtype;
    const ctx = this.toAdapterContext(state);

    if (subtype === "set_model") {
      const nextModel = req.model === "default" ? undefined : req.model;
      state.model = nextModel;
      await state.adapter.setModel?.(ctx, nextModel);
      return [successResponse(reqId, { model: state.model || "default" })];
    }

    if (subtype === "set_permission_mode") {
      state.permissionMode = req.mode;
      await state.adapter.setPermissionMode?.(ctx, req.mode);
      return [successResponse(reqId, { mode: state.permissionMode })];
    }

    if (subtype === "set_max_thinking_tokens") {
      const max = req.max_thinking_tokens;
      if (max !== null && (!Number.isFinite(max) || max < 0)) {
        throw new GatewayError("INVALID_ARGUMENT", "set_max_thinking_tokens.max_thinking_tokens must be null or >= 0");
      }
      state.maxThinkingTokens = max ?? undefined;
      await state.adapter.setMaxThinkingTokens?.(ctx, max);
      return [successResponse(reqId, { maxThinkingTokens: state.maxThinkingTokens ?? null })];
    }

    if (subtype === "interrupt") {
      await state.adapter.interrupt?.(ctx);
      return [successResponse(reqId, { interrupted: true })];
    }

    if (subtype === "can_use_tool") {
      state.pendingPermissions.add(reqId, state.sessionId, req);
      const defaultBehavior = (process.env.UNIFIED_AGENT_CAN_USE_TOOL_DEFAULT || "deny").toLowerCase();
      const candidate = defaultBehavior === "allow" ? { behavior: "allow", updatedInput: req.input } : { behavior: "deny" };
      const decision = validateCanUseToolDecision(candidate);
      state.pendingPermissions.resolve(reqId);
      return [successResponse(reqId, decision)];
    }

    if (subtype === "mcp_status") {
      const status = await state.adapter.mcpStatus?.(ctx);
      return [successResponse(reqId, status ?? { supported: false })];
    }

    if (subtype === "mcp_message") {
      const out = await state.adapter.mcpMessage?.(ctx, req.server_name, req.message);
      return [successResponse(reqId, out ?? { supported: false })];
    }

    if (subtype === "mcp_set_servers") {
      const out = await state.adapter.mcpSetServers?.(ctx, req.servers);
      return [successResponse(reqId, out ?? { supported: false })];
    }

    if (subtype === "mcp_reconnect") {
      const out = await state.adapter.mcpReconnect?.(ctx, req.serverName);
      return [successResponse(reqId, out ?? { supported: false })];
    }

    if (subtype === "mcp_toggle") {
      const out = await state.adapter.mcpToggle?.(ctx, req.serverName, req.enabled);
      return [successResponse(reqId, out ?? { supported: false })];
    }

    if (subtype === "rewind_files") {
      const out = await state.adapter.rewindFiles?.(ctx, req.user_message_id, req.dry_run);
      return [successResponse(reqId, out ?? { supported: false })];
    }

    if (subtype === "hook_callback") {
      const out = await state.adapter.hookCallback?.(ctx, req.callback_id, req.input, req.tool_use_id);
      return [successResponse(reqId, out ?? { supported: false })];
    }

    const _exhaustive: never = subtype;
    throw new GatewayError("UNKNOWN_SUBTYPE", `unknown subtype: ${String(_exhaustive)}`);
  }

  private async handleControlCancel(sessionId: string, envelope: UcpControlCancelRequest): Promise<UcpEnvelope[]> {
    const state = this.registry.get(sessionId);
    if (!state) {
      return [errorResponse(envelope.request_id, "session not initialized", "NOT_INITIALIZED")];
    }
    state.pendingRequests.delete(envelope.request_id);
    const pending = state.pendingPermissions.resolve(envelope.request_id);

    const out: UcpEnvelope[] = [successResponse(envelope.request_id, { cancelled: true })];
    if (pending) {
      out.push({
        type: "permission_cancelled",
        session_id: sessionId,
        request_id: envelope.request_id,
        reason: "cancelled by control_cancel_request",
      });
    }
    this.persistState();
    return out;
  }

  private async handleUserMessage(sessionId: string, envelope: UcpUserMessage): Promise<UcpEnvelope[]> {
    const state = this.registry.get(sessionId);
    if (!state) {
      return [{ type: "error", code: "NOT_INITIALIZED", message: "session not initialized" }];
    }

    const ctx = this.toAdapterContext(state);
    const result = await state.adapter.askUser(ctx, envelope.message.content);
    if (result.providerSessionId) {
      state.providerSessionId = result.providerSessionId;
    }

    const assistantEvent: UcpEnvelope = {
      type: "assistant",
      session_id: sessionId,
      event: {
        subtype: "message",
        text: result.text,
      },
    };
    state.replay.push(envelope);
    state.replay.push(assistantEvent);
    this.persistState();

    if (this.sessionManager) {
      await this.sessionManager.recordControlRequest("user", { sessionId, text: envelope.message.content });
      await this.sessionManager.recordAssistant(result.text);
      await this.sessionManager.setProviderSessionId(result.providerSessionId);
    }

    return [assistantEvent];
  }

  private toAdapterContext(state: GatewaySessionState): AdapterSessionContext {
    return {
      metaSessionId: state.metaSessionId,
      gatewaySessionId: state.gatewaySessionId,
      providerSessionId: state.providerSessionId,
      project: state.project,
      cwd: state.cwd,
      provider: state.provider,
      model: state.model,
      brainUrl: state.brainUrl,
      permissionMode: state.permissionMode,
      maxThinkingTokens: state.maxThinkingTokens,
    };
  }

  private async persistControl(request: UcpControlRequest, response?: UcpEnvelope): Promise<void> {
    if (!this.sessionManager) return;
    await this.sessionManager.recordControlRequest(request.request.subtype, request.request);
    if (response && response.type === "control_response") {
      await this.sessionManager.recordControlResponse(response.response.subtype, response.response);
    }
  }

  private persistState(): void {
    this.stateStore.save(this.registry.list());
  }
}

export function isControlSubtype(value: string): value is ControlSubtype {
  return (
    value === "initialize" ||
    value === "can_use_tool" ||
    value === "interrupt" ||
    value === "set_permission_mode" ||
    value === "set_model" ||
    value === "set_max_thinking_tokens" ||
    value === "mcp_status" ||
    value === "mcp_message" ||
    value === "mcp_set_servers" ||
    value === "mcp_reconnect" ||
    value === "mcp_toggle" ||
    value === "rewind_files" ||
    value === "hook_callback"
  );
}
