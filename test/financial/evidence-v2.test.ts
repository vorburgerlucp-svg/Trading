import { describe, expect, it } from 'vitest';
import { hashOf } from '../../src/persistence/canonical-json.js';
import { AAPL_ID, T0 } from './fixtures.js';
import { fundamentalsEvidence } from './evidence-factory.js';

// docs/FINANCIAL_EVIDENCE_PERSISTENCE_V1.md §2–§3. Evidence v2 carries the canonical request it was computed from, so a stored row can recompute its own
// identity. The request snapshot excludes requestId. Process times never change identity.

describe('evidence v2 carries its canonical request (§2)', () => {
  it('the schema version is financial-evidence:v2', async () => {
    expect((await fundamentalsEvidence()).schemaVersion).toBe('financial-evidence:v2');
  });

  it('the request snapshot holds the validated fields and no requestId', async () => {
    const e = await fundamentalsEvidence({ requestId: 'r-42' });
    expect(e.request).toEqual({ capability: 'fundamentals', connectorId: 'fund-mcp', asOf: T0, environment: 'research', instrumentId: AAPL_ID, currency: 'USD', period: '2025-Q4' });
    expect(Object.keys(e.request)).not.toContain('requestId');
    expect(Object.isFrozen(e.request)).toBe(true);
  });

  it('queryFingerprint is the hash of the canonical request snapshot', async () => {
    const e = await fundamentalsEvidence();
    expect(e.queryFingerprint).toBe(hashOf(e.request));
  });
});

describe('identity excludes correlation and process metadata (§3)', () => {
  it('only requestId changes: same queryFingerprint, same evidenceId', async () => {
    const a = await fundamentalsEvidence({ requestId: 'r-1' });
    const b = await fundamentalsEvidence({ requestId: 'r-2' });
    expect(b.queryFingerprint).toBe(a.queryFingerprint);
    expect(b.evidenceId).toBe(a.evidenceId);
  });

  it('only the process clocks change: same evidenceId, different receipt times', async () => {
    const a = await fundamentalsEvidence({ nexusAt: '2026-06-01T10:00:00.000Z', retrievedAt: '2026-06-01T10:00:00.000Z' });
    const b = await fundamentalsEvidence({ nexusAt: '2026-07-09T09:00:00.000Z', retrievedAt: '2026-07-09T08:59:00.000Z' });
    expect(b.evidenceId).toBe(a.evidenceId);
    expect(b.createdAt).not.toBe(a.createdAt);
    expect(b.retrievedAt).not.toBe(a.retrievedAt);
  });

  it('asOf is semantic: a different asOf changes queryFingerprint and evidenceId', async () => {
    const a = await fundamentalsEvidence({ asOf: '2026-06-01T10:00:00.000Z' });
    const b = await fundamentalsEvidence({ asOf: '2026-06-02T10:00:00.000Z' });
    expect(b.queryFingerprint).not.toBe(a.queryFingerprint);
    expect(b.evidenceId).not.toBe(a.evidenceId);
  });

  it('the provider publication time is semantic: a different publication time changes evidenceId', async () => {
    const a = await fundamentalsEvidence({ providerPublishedAt: '2026-02-01T00:00:00.000Z' });
    const b = await fundamentalsEvidence({ providerPublishedAt: '2026-03-01T00:00:00.000Z' });
    expect(b.evidenceId).not.toBe(a.evidenceId);
  });
});
