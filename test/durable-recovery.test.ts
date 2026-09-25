import { afterEach, describe, expect, it } from 'vitest';

import {
  durableRecoveryIncidents,
  durableRecoveryPaused,
  noteDurableRecoveryIncident,
  resetDurableRecoveryForTests,
  resolveDurableRecoveryIncident
} from '../src/main/durable-recovery.js';

afterEach(() => {
  resetDurableRecoveryForTests();
});

describe('durable recovery coordinator', () => {
  it('pauses only the affected authority domain', () => {
    noteDurableRecoveryIncident({
      domain: 'long-run',
      ledger: 'long-run',
      failure: 'json_corrupt',
      disposition: 'pause',
      detectedAt: 10
    });

    expect(durableRecoveryPaused('long-run')).toBe(true);
    expect(durableRecoveryPaused('goal')).toBe(false);
  });
  it('records degraded checkpoint health without revoking accepted authority', () => {
    noteDurableRecoveryIncident({
      domain: 'agents',
      ledger: 'swarm',
      copy: 'backup',
      failure: 'checkpoint_degraded',
      disposition: 'degraded',
      detail: ' backup write failed  after commit '
    });

    expect(durableRecoveryPaused('agents')).toBe(false);
    expect(durableRecoveryIncidents('agents')).toEqual([
      expect.objectContaining({
        ledger: 'swarm',
        copy: 'backup',
        disposition: 'degraded',
        detail: 'backup write failed after commit'
      })
    ]);
  });

  it('keeps a domain paused until every blocking incident is resolved exactly', () => {
    noteDurableRecoveryIncident({
      domain: 'goal', ledger: 'goal-switches', failure: 'schema_invalid', disposition: 'pause', detectedAt: 20
    });
    noteDurableRecoveryIncident({
      domain: 'goal', ledger: 'goal-replies', failure: 'json_corrupt', disposition: 'pause', detectedAt: 30
    });

    expect(resolveDurableRecoveryIncident('goal', 'goal-switches')).toBe(true);
    expect(durableRecoveryPaused('goal')).toBe(true);
    expect(resolveDurableRecoveryIncident('goal', 'goal-replies')).toBe(true);
    expect(durableRecoveryPaused('goal')).toBe(false);
  });

  it('refreshes one incident without losing its original detection time', () => {
    noteDurableRecoveryIncident({
      domain: 'input', ledger: 'session-input', failure: 'json_corrupt', disposition: 'pause', detectedAt: 40
    });
    noteDurableRecoveryIncident({
      domain: 'input', ledger: 'session-input', failure: 'io_error', disposition: 'pause', detectedAt: 90
    });

    expect(durableRecoveryIncidents('input')).toEqual([
      expect.objectContaining({ detectedAt: 40, failure: 'io_error' })
    ]);
  });
  it('rejects invalid ledger identities instead of creating an ambiguous recovery key', () => {
    expect(() => noteDurableRecoveryIncident({
      domain: 'continuation',
      ledger: '../continuations',
      failure: 'io_error',
      disposition: 'pause'
    })).toThrow('Invalid durable recovery ledger');
  });
});
