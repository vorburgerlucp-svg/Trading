import { describe, expect, it } from 'vitest';
import { InstrumentRegistry, type InstrumentEvent } from '../../src/market-data/instrument-registry.js';
import { AppendOnlyLog, InMemoryAppendOnlyStore } from '../../src/persistence/append-only-log.js';
import { sequentialIds } from '../helpers.js';
import { AAPL, BTC } from './fixtures.js';

const HUMAN = { kind: 'human' as const, id: 'luc' };
const at = (iso: string) => ({ at: iso, by: HUMAN, reason: 'test' });

async function registry(store = new InMemoryAppendOnlyStore<InstrumentEvent>()) {
  const r = await InstrumentRegistry.open(store, { newId: sequentialIds('r-') });
  await r.register({ ...AAPL }, at('2026-01-01T00:00:00Z'));
  await r.addMapping({ instrumentId: AAPL.instrumentId, provider: 'twelvedata', providerSymbol: 'AAPL', validFrom: '1980-12-12T00:00:00Z' }, at('2026-01-01T00:00:00Z'));
  return { r, store };
}

describe('Instrument Registry: Symbol ist keine Identität', () => {
  it('Provider-Symbol → NEXUS-Instrument, zeitabhängig', async () => {
    const { r } = await registry();
    expect(r.resolve('twelvedata', 'aapl', '2026-10-07T00:00:00Z')).toBe(AAPL.instrumentId);
    expect(r.resolve('twelvedata', 'AAPL', '1970-01-01T00:00:00Z')).toBeNull();
    expect(r.resolve('massive', 'AAPL', '2026-10-07T00:00:00Z')).toBeNull();
    expect(r.mappingAt(AAPL.instrumentId, 'twelvedata', '2026-10-07T00:00:00Z')?.providerSymbol).toBe('AAPL');
  });

  it('überlappende Zuordnungen werden abgewiesen (ein Symbol, zwei Instrumente / zwei Symbole, ein Instrument)', async () => {
    const { r } = await registry();
    await r.register({ ...BTC }, at('2026-01-02T00:00:00Z'));
    await expect(r.addMapping({ instrumentId: BTC.instrumentId, provider: 'twelvedata', providerSymbol: 'AAPL', validFrom: '2020-01-01T00:00:00Z' }, at('2026-01-02T00:00:00Z'))).rejects.toMatchObject({ code: 'conflict' });
    await expect(r.addMapping({ instrumentId: AAPL.instrumentId, provider: 'twelvedata', providerSymbol: 'APPL', validFrom: '2020-01-01T00:00:00Z' }, at('2026-01-02T00:00:00Z'))).rejects.toMatchObject({ code: 'conflict' });
    // a different provider is fine
    await r.addMapping({ instrumentId: AAPL.instrumentId, provider: 'massive', providerSymbol: 'AAPL', validFrom: '2020-01-01T00:00:00Z' }, at('2026-01-02T00:00:00Z'));
  });

  it('Attribute, die gespeicherte Historie umdeuten würden, sind unveränderlich', async () => {
    const { r } = await registry();
    for (const change of [{ timezone: 'Europe/Zurich' }, { currency: 'CHF' }, { assetClass: 'etf' }]) {
      await expect(r.update(AAPL.instrumentId, change as never, at('2026-02-01T00:00:00Z'))).rejects.toThrow(/cannot be changed/);
    }
    expect((await r.update(AAPL.instrumentId, { active: false }, at('2026-02-01T00:00:00Z'))).active).toBe(false);
  });

  it('nur Mensch oder System dürfen ändern; Steuerzeichen in Namen werden abgewiesen', async () => {
    const { r } = await registry();
    await expect(r.update(AAPL.instrumentId, { name: 'x' }, { at: '2026-02-01T00:00:00Z', by: { kind: 'ai', id: 'gpt' } as never, reason: 'self-edit' })).rejects.toThrow(/human or system/);
    await expect(r.update(AAPL.instrumentId, { name: 'Apple\u0000Inc' }, at('2026-02-01T00:00:00Z'))).rejects.toThrow(/printable/);
  });

  it('direkt in den Speicher geschriebene, regelwidrige Zuordnung: Integritätsfehler beim Laden (fail closed)', async () => {
    const { store } = await registry();
    const raw = await AppendOnlyLog.open<InstrumentEvent>('instruments', store);
    await raw.append('forged', { type: 'mapping_added', eventId: 'forged', at: '2026-03-01T00:00:00Z', by: HUMAN, reason: 'db edit', mapping: { instrumentId: 'ins_ghost', provider: 'twelvedata', providerSymbol: 'TSLA', validFrom: '2020-01-01T00:00:00Z' } });
    await expect(InstrumentRegistry.open(store)).rejects.toMatchObject({ code: 'INSTRUMENT_REGISTRY_INTEGRITY_ERROR' });
  });
});
