import type { CanUseToolControl, UcpPermissionCancelled } from "./protocol";

export interface PendingPermission {
  requestId: string;
  sessionId: string;
  createdAt: number;
  request: CanUseToolControl;
}

export class PendingPermissions {
  private readonly byRequestId = new Map<string, PendingPermission>();

  add(requestId: string, sessionId: string, request: CanUseToolControl): void {
    this.byRequestId.set(requestId, {
      requestId,
      sessionId,
      createdAt: Date.now(),
      request,
    });
  }

  has(requestId: string): boolean {
    return this.byRequestId.has(requestId);
  }

  resolve(requestId: string): PendingPermission | undefined {
    const value = this.byRequestId.get(requestId);
    if (value) this.byRequestId.delete(requestId);
    return value;
  }

  listBySession(sessionId: string): PendingPermission[] {
    const out: PendingPermission[] = [];
    for (const item of this.byRequestId.values()) {
      if (item.sessionId === sessionId) out.push(item);
    }
    return out;
  }

  cancelBySession(sessionId: string, reason: string): UcpPermissionCancelled[] {
    const out: UcpPermissionCancelled[] = [];
    for (const item of this.byRequestId.values()) {
      if (item.sessionId !== sessionId) continue;
      this.byRequestId.delete(item.requestId);
      out.push({
        type: "permission_cancelled",
        session_id: sessionId,
        request_id: item.requestId,
        reason,
      });
    }
    return out;
  }

  toArray(): PendingPermission[] {
    return [...this.byRequestId.values()];
  }

  static fromArray(items: PendingPermission[]): PendingPermissions {
    const p = new PendingPermissions();
    for (const item of items || []) {
      if (!item || typeof item.requestId !== "string" || typeof item.sessionId !== "string") continue;
      p.byRequestId.set(item.requestId, item);
    }
    return p;
  }
}
