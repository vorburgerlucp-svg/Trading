import { describe, expect, it } from 'vitest';
import type { BarRevisionKnowledge } from '../../src/market-data/market-data-types.js';
import { barProvenanceHashV1, v1MirrorOf } from '../../src/persistence/postgres/bar-compat.js';

// The 008 compatibility mirror (persistence only) and the 008 integrity hash. The golden values were computed by the ORIGINAL
// release (de4c3f4, barProvenanceHash) over the same inputs: the rule of 008 must reproduce them, or rows stored under it fail.

const knowledge = (k: Partial<BarRevisionKnowledge> & Pick<BarRevisionKnowledge, 'knowledgeSource' | 'vintage'>): BarRevisionKnowledge => ({ knownAt: null, vintagePolicy: 'bar-vintage:v1', ...k });

describe('the 008 mirror of the V2 knowledge', () => {
  it('a contemporaneous capture is captured_by_nexus, known at its retrieval', () => {
    expect(v1MirrorOf(knowledge({ knowledgeSource: 'captured_by_nexus', vintage: 'contemporaneous', knownAt: '2026-09-25T20:02:00.000Z' }))).toEqual({
      knowledgeProvenance: 'captured_by_nexus',
      revisionKnownAt: '2026-09-25T20:02:00.000Z',
    });
  });

  it('a backfill is historical_bar_reconstruction: 008 has no knowledge time for it (V2 still knows it from its retrieval)', () => {
    expect(v1MirrorOf(knowledge({ knowledgeSource: 'captured_by_nexus', vintage: 'historical_reconstruction', knownAt: '2026-10-09T12:00:00.000Z' }))).toEqual({
      knowledgeProvenance: 'historical_bar_reconstruction',
      revisionKnownAt: null,
    });
  });

  it('a provider publication is provider_published_at, known at its publication time (whatever the vintage)', () => {
    expect(v1MirrorOf(knowledge({ knowledgeSource: 'provider_published_at', vintage: 'contemporaneous', knownAt: '2026-09-25T20:01:00.000Z' }))).toEqual({
      knowledgeProvenance: 'provider_published_at',
      revisionKnownAt: '2026-09-25T20:01:00.000Z',
    });
  });

  it('a legacy revision has no 008 value: nothing may be written for it', () => {
    expect(() => v1MirrorOf(knowledge({ knowledgeSource: 'legacy_unproven', vintage: 'legacy_unproven', knownAt: null }))).toThrow(/legacy revision has no 008 value/);
  });
});

describe('the 008 integrity hash keeps the rule of its release', () => {
  const base = {
    instrumentId: 'ins_aapl',
    source: 'twelvedata:time_series:production',
    interval: '1d' as const,
    session: 'regular' as const,
    adjustment: 'raw' as const,
    startTime: '2026-09-25T04:00:00.000Z',
    contentHash: 'b'.repeat(64),
    retrievedAt: '2026-09-25T20:02:00.000Z',
    observedAt: '2026-09-25T20:00:00.000Z',
    availableAt: '2026-09-25T20:00:00.000Z',
  };

  it('reproduces the golden values of the released rule, for each knowledge shape', () => {
    expect(barProvenanceHashV1(base, { knowledgeProvenance: 'captured_by_nexus', revisionKnownAt: '2026-09-25T20:02:00.000Z' })).toBe('96e0e7b4887a0646ddca1e5b516b9f228cf6cd7616edc95479db0b6a724ef138');
    expect(barProvenanceHashV1(base, { knowledgeProvenance: 'historical_bar_reconstruction', revisionKnownAt: null })).toBe('4d4a3e7072ab1667e9f44423244230c823742b82ce03437f021730423f2fb69b');
    expect(barProvenanceHashV1(base, { knowledgeProvenance: 'provider_published_at', revisionKnownAt: '2026-09-25T20:01:00.000Z' })).toBe('4719b77684a1e0d748e71cfb7961a22191da71444b2671ab9aa93e9746b81319');
  });

  it('reproduces the golden values of two stored rows of the released history (content hash included)', () => {
    const realCapture = { ...base, source: 'fixture:bars:production', contentHash: '8acf3d64663df037999606308e7436ea0d422d131fe1faeb69b206fbfe893fbc' };
    expect(barProvenanceHashV1(realCapture, { knowledgeProvenance: 'captured_by_nexus', revisionKnownAt: '2026-09-25T20:02:00.000Z' })).toBe('8e2b079755058fff8332f0398a767caa72bef0f9dd9e9e955e65f8981df6382c');
    const realBackfill = { ...realCapture, startTime: '2026-09-24T04:00:00.000Z', endTime: '2026-09-25T04:00:00.000Z', contentHash: '2a07c33c7fc6aece9c3f933ff17db2afbdf9d1073c399c5ded87f2a19fe99c46', retrievedAt: '2026-10-01T12:00:00.000Z', observedAt: '2026-09-24T20:00:00.000Z', availableAt: '2026-09-24T20:00:00.000Z' };
    expect(barProvenanceHashV1(realBackfill, { knowledgeProvenance: 'historical_bar_reconstruction', revisionKnownAt: null })).toBe('ef087abb316730ba33a8d0cf41e3a1c7fa73261ab335a577aa361ff8b0e62844');
  });

  it('changes when any protected field changes (the 008 values are not interchangeable)', () => {
    const mirror = { knowledgeProvenance: 'captured_by_nexus', revisionKnownAt: '2026-09-25T20:02:00.000Z' };
    const reference = barProvenanceHashV1(base, mirror);
    expect(barProvenanceHashV1(base, { ...mirror, knowledgeProvenance: 'provider_published_at' })).not.toBe(reference);
    expect(barProvenanceHashV1(base, { ...mirror, revisionKnownAt: '2026-09-25T20:03:00.000Z' })).not.toBe(reference);
    expect(barProvenanceHashV1({ ...base, availableAt: '2026-09-25T20:01:00.000Z' }, mirror)).not.toBe(reference);
  });
});
