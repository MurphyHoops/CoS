/**
 * CoS Next OS-local approval broker.
 *
 * Tokens are object-identity capabilities held only in the native main process,
 * never serialized as MCP args, persisted, sent to a renderer or put in logs.
 * The native decision callback MUST originate from an OS-owned approval dialog.
 */
export type ApprovalOperation = 'project' | 'create' | 'browse' | 'grant' | 'revoke' |
  'rebind' | 'resume' | 'tunnel';
type ApprovalTicket = Readonly<object>;
type ApprovalRecord = {
  operation: ApprovalOperation; scope: string; expiresAt: number; used: boolean;
};
const SAFE_SCOPE = /^[a-zA-Z0-9_.:-]{1,128}$/;
export class NextNativeApprovalBroker {
  private readonly tickets = new WeakMap<object, ApprovalRecord>();
  constructor(
    private readonly decide: (operation: ApprovalOperation, scope: string) => Promise<boolean>,
    private readonly now: () => number = Date.now,
    private readonly ttlMs = 30_000
  ) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > 120_000) {
      throw new Error('INVALID_APPROVAL_TTL');
    }
  }
  /** Use ONLY behind OS/native code. Do not publish as an MCP tool. */
  async request(operation: ApprovalOperation, scope: string): Promise<ApprovalTicket | null> {
    if (!SAFE_SCOPE.test(scope) || Object.prototype.hasOwnProperty.call(Object.prototype, scope)) {
      throw new Error('INVALID_APPROVAL_SCOPE');
    }
    let approved = false;
    try { approved = await this.decide(operation, scope) === true; } catch { /* deny */ }
    if (!approved) return null;
    const ticket: ApprovalTicket = Object.freeze(Object.create(null));
    this.tickets.set(ticket, {
      operation, scope, used: false, expiresAt: this.now() + this.ttlMs
    });
    return ticket;
  }
  /** Consume atomically before returning; a duplicate tool call cannot reuse it. */
  async consume(ticket: unknown, operation: ApprovalOperation, scope: string): Promise<boolean> {
    if (ticket == null || typeof ticket !== 'object') return false;
    const record = this.tickets.get(ticket);
    if (!record || record.used || this.now() >= record.expiresAt ||
        record.operation !== operation || record.scope !== scope) return false;
    record.used = true;
    return true;
  }
}
