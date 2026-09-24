/**
 * Process-local coordination for durable control-ledger recovery.
 *
 * This module never restores an owner and never decides whether a backup is safe. Owners report
 * incidents after classifying their own state; callers use the derived domain pause to deny new
 * mutation authority until that exact owner resolves the incident.
 */

export const DURABLE_RECOVERY_DOMAINS = [
  'goal',
  'agents',
  'continuation',
  'long-run',
  'blocked-tools',
  'input',
  'browser-command'
] as const;

export type DurableRecoveryDomain = typeof DURABLE_RECOVERY_DOMAINS[number];
export type DurableRecoveryCopy = 'primary' | 'backup';
export type DurableRecoveryFailure = 'json_corrupt' | 'schema_invalid' | 'io_error' | 'checkpoint_degraded';
export type DurableRecoveryDisposition = 'pause' | 'degraded';

export interface DurableRecoveryIncident {
  domain: DurableRecoveryDomain;
  ledger: string;
  copy: DurableRecoveryCopy;
  failure: DurableRecoveryFailure;
  disposition: DurableRecoveryDisposition;
  detectedAt: number;
  detail: string | null;
}
export interface NoteDurableRecoveryIncident {
  domain: DurableRecoveryDomain;
  ledger: string;
  copy?: DurableRecoveryCopy;
  failure: DurableRecoveryFailure;
  disposition: DurableRecoveryDisposition;
  detectedAt?: number;
  detail?: string | null;
}

const incidents = new Map<string, DurableRecoveryIncident>();

function validLedger(ledger: string): boolean {
  return /^[a-z0-9-]{1,40}$/.test(ledger);
}

function keyFor(domain: DurableRecoveryDomain, ledger: string, copy: DurableRecoveryCopy): string {
  return `${domain}:${ledger}:${copy}`;
}

function clone(incident: DurableRecoveryIncident): DurableRecoveryIncident {
  return { ...incident };
}

function normalizeDetail(detail: string | null | undefined): string | null {
  if (!detail) return null;
  return detail.replace(/\s+/g, ' ').trim().slice(0, 500) || null;
}
/** Records or refreshes one exact ledger incident without changing any owner state. */
export function noteDurableRecoveryIncident(input: NoteDurableRecoveryIncident): DurableRecoveryIncident {
  if (!validLedger(input.ledger)) throw new Error(`Invalid durable recovery ledger: ${input.ledger}`);
  const copy = input.copy ?? 'primary';
  const key = keyFor(input.domain, input.ledger, copy);
  const existing = incidents.get(key);
  const now = Number.isFinite(input.detectedAt) && Number(input.detectedAt) > 0
    ? Number(input.detectedAt)
    : Date.now();
  const incident: DurableRecoveryIncident = {
    domain: input.domain,
    ledger: input.ledger,
    copy,
    failure: input.failure,
    disposition: input.disposition,
    detectedAt: existing?.detectedAt ?? now,
    detail: normalizeDetail(input.detail)
  };
  incidents.set(key, incident);
  return clone(incident);
}

/** Clears only the incident an owner has independently proved safe/recovered. */
export function resolveDurableRecoveryIncident(
  domain: DurableRecoveryDomain,
  ledger: string,
  copy: DurableRecoveryCopy = 'primary'
): boolean {
  if (!validLedger(ledger)) throw new Error(`Invalid durable recovery ledger: ${ledger}`);
  return incidents.delete(keyFor(domain, ledger, copy));
}
/** New mutation authority for this domain stays paused while any blocking incident remains. */
export function durableRecoveryPaused(domain: DurableRecoveryDomain): boolean {
  for (const incident of incidents.values()) {
    if (incident.domain === domain && incident.disposition === 'pause') return true;
  }
  return false;
}

export function durableRecoveryIncidents(domain?: DurableRecoveryDomain): DurableRecoveryIncident[] {
  return [...incidents.values()]
    .filter((incident) => !domain || incident.domain === domain)
    .sort((a, b) => a.detectedAt - b.detectedAt || a.ledger.localeCompare(b.ledger) || a.copy.localeCompare(b.copy))
    .map(clone);
}

/** Test seam; production restart reconstructs incidents from the still-present durable evidence. */
export function resetDurableRecoveryForTests(): void {
  incidents.clear();
}
