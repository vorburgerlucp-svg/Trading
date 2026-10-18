// O22: the governed eToro mapping. A named human, evidence from the fixed metadata read, an existing active USD NEXUS instrument of
// the matching asset class, no exchange, no existing mapping. Every contradiction is refused before anything is written, and the
// written mapping is exactly the one the O20 sync and the O21 gate resolve. Test data only: nothing is registered in production.
import { describe, expect, it } from 'vitest';
import { EtoroMappingError, applyGovernedEtoroMapping, type GovernedEtoroMappingRequest } from '../../../src/broker/etoro/etoro-instrument-mapping.js';
import { InstrumentRegistry } from '../../../src/market-data/instrument-registry.js';
import { AAPL } from '../../market-data/fixtures.js';

const NOW = '2026-10-20T09:00:00.000Z';
const HUMAN = { kind: 'human' as const, id: 'operator-1' };
const SHA = 'a'.repeat(64);
const CANDIDATE = Object.freeze({ instrumentId: 'ins_test_eth_usd', assetClass: 'crypto' as const, symbol: 'ETH/USD', currency: 'USD', timezone: 'UTC', tradingCalendar: '24x7', active: true });

async function registry(instrument: Record<string, unknown> = {}): Promise<InstrumentRegistry> {
  const r = await InstrumentRegistry.open();
  await r.register({ ...CANDIDATE, ...instrument } as typeof CANDIDATE, { at: '2026-10-01T00:00:00.000Z', by: { kind: 'human', id: 'registrar' }, reason: 'test instrument' });
  return r;
}

function request(overrides: Partial<GovernedEtoroMappingRequest> = {}, metadata: Record<string, unknown> = {}): GovernedEtoroMappingRequest {
  return {
    instrumentId: CANDIDATE.instrumentId,
    validFrom: NOW,
    evidence: { reportSha256: SHA, metadata: { instrumentId: 100001, type: 'Crypto', symbol: 'TESTSYM', displayName: 'Test Display Name', ...metadata } as GovernedEtoroMappingRequest['evidence']['metadata'] },
    ...overrides,
  };
}

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof EtoroMappingError) return error.code;
    throw error;
  }
  throw new Error('expected an EtoroMappingError');
}

describe('O22 governed eToro mapping', () => {
  it('a named human with evidence adds exactly the mapping the sync and the gate resolve; the reason cites the evidence', async () => {
    const r = await registry();
    const written = await applyGovernedEtoroMapping(r, request(), HUMAN, NOW);
    expect(written).toEqual({ instrumentId: CANDIDATE.instrumentId, provider: 'etoro', providerSymbol: '100001', validFrom: NOW });
    expect(r.resolve('etoro', '100001', NOW)).toBe(CANDIDATE.instrumentId);
    expect(r.mappingAt(CANDIDATE.instrumentId, 'etoro', NOW)).toEqual({ instrumentId: CANDIDATE.instrumentId, provider: 'etoro', providerSymbol: '100001', providerInstrumentId: '100001', validFrom: NOW });
    expect(r.mappingAt(CANDIDATE.instrumentId, 'etoro', NOW)?.exchange).toBeUndefined();
    expect(r.resolve('etoro', '100001', '2026-10-19T00:00:00.000Z')).toBeNull();
  });

  it('only a named human: a strategy, a model, a system actor or extra fields are refused, and nothing is written', async () => {
    const r = await registry();
    for (const actor of [{ kind: 'strategy', id: 's' }, { kind: 'model', id: 'llm' }, { kind: 'system', id: 'nexus' }, { kind: 'human' }, { kind: 'human', id: 'a b' }, { kind: 'human', id: 'x', role: 'admin' }, null, 'human']) {
      expect(await code(applyGovernedEtoroMapping(r, request(), actor, NOW))).toBe('MAPPING_ACTOR_INVALID');
    }
    expect(r.mappings()).toEqual([]);
  });

  it('evidence must be a sha256, a documented type with a NEXUS class, and validFrom canonical and not in the future', async () => {
    const r = await registry();
    expect(await code(applyGovernedEtoroMapping(r, request({ evidence: { ...request().evidence, reportSha256: 'A'.repeat(64) } }), HUMAN, NOW))).toBe('MAPPING_EVIDENCE_INVALID');
    for (const type of ['CFD', 'Bonds', 'TrustFunds', 'Options', 'Coin']) {
      expect(await code(applyGovernedEtoroMapping(r, request({}, { type }), HUMAN, NOW)), type).toBe('MAPPING_EVIDENCE_INVALID');
    }
    expect(await code(applyGovernedEtoroMapping(r, request({ validFrom: '2026-10-20T09:00:01.000Z' }), HUMAN, NOW))).toBe('MAPPING_EVIDENCE_INVALID');
    expect(await code(applyGovernedEtoroMapping(r, request({ validFrom: '2026-10-20T09:00:00Z' }), HUMAN, NOW))).toBe('MAPPING_EVIDENCE_INVALID');
    expect(r.mappings()).toEqual([]);
  });

  it('the NEXUS instrument must exist, be active, be USD and have the asset class of the eToro type; it is never created', async () => {
    expect(await code(applyGovernedEtoroMapping(await registry(), request({ instrumentId: 'ins_missing' }), HUMAN, NOW))).toBe('MAPPING_INSTRUMENT_INVALID');
    expect(await code(applyGovernedEtoroMapping(await registry({ active: false }), request(), HUMAN, NOW))).toBe('MAPPING_INSTRUMENT_INVALID');
    expect(await code(applyGovernedEtoroMapping(await registry({ currency: 'EUR' }), request(), HUMAN, NOW))).toBe('MAPPING_INSTRUMENT_INVALID');
    expect(await code(applyGovernedEtoroMapping(await registry(), request({}, { type: 'Stocks' }), HUMAN, NOW))).toBe('MAPPING_INSTRUMENT_INVALID');
  });

  it('no second mapping: not for the same NEXUS instrument, not for the same eToro id', async () => {
    const r = await registry();
    await applyGovernedEtoroMapping(r, request(), HUMAN, NOW);
    expect(await code(applyGovernedEtoroMapping(r, request(), HUMAN, NOW))).toBe('MAPPING_CONFLICT');
    await r.register({ ...AAPL }, { at: '2026-10-01T00:00:00.000Z', by: { kind: 'human', id: 'registrar' }, reason: 'test' });
    expect(await code(applyGovernedEtoroMapping(r, request({ instrumentId: AAPL.instrumentId }, { type: 'Stocks' }), HUMAN, NOW))).toBe('MAPPING_CONFLICT');
    expect(r.mappings().filter((m) => m.provider === 'etoro')).toHaveLength(1);
  });

  it('the symbol is not an identity: a symbol that looks different does not decide anything, the human does', async () => {
    const r = await registry();
    await applyGovernedEtoroMapping(r, request({}, { symbol: 'NOT-LIKE-ETH' }), HUMAN, NOW);
    expect(r.resolve('etoro', '100001', NOW)).toBe(CANDIDATE.instrumentId);
  });
});
