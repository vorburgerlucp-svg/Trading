// O22 B4: the governed mapping tool. Dry run by default (writes nothing); --apply needs --confirm-human-mapping; the evidence is the
// unchanged report file of the metadata read, cited by its sha256; every check runs before the one registry write. No broker request.
// In-memory registry; the report files are TEST DATA.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { APPLY_FLAG, CONFIRM_MAPPING_FLAG, runMapping } from '../../../src/broker/etoro/etoro-map-instrument-cli.js';
import { instrumentMetadataReport } from '../../../src/broker/etoro/etoro-instrument-metadata.js';
import { InstrumentRegistry } from '../../../src/market-data/instrument-registry.js';

const NOW = '2026-10-20T09:00:00.000Z';
const INSTRUMENT = { instrumentId: 'ins_test_eth_usd', assetClass: 'crypto' as const, symbol: 'ETH/USD', currency: 'USD', timezone: 'UTC', tradingCalendar: '24x7', active: true };
const REPORT = Buffer.from(JSON.stringify(instrumentMetadataReport({ results: [{ instrumentId: 100001, type: 'Crypto', symbol: 'TESTSYM', displayName: 'Test Display Name' }] }), null, 2) + '\n');
const SHA = createHash('sha256').update(REPORT).digest('hex');
const ARGS = ['--instrument-id=' + INSTRUMENT.instrumentId, '--metadata-report=report.json', '--valid-from=' + NOW, '--operator=operator-1'];

async function harness(files: Record<string, Buffer> = { 'report.json': REPORT }) {
  const registry = await InstrumentRegistry.open();
  await registry.register(INSTRUMENT, { at: '2026-10-01T00:00:00.000Z', by: { kind: 'human', id: 'registrar' }, reason: 'test instrument' });
  let closed = 0;
  const run = (argv: string[]) =>
    runMapping({
      argv,
      now: NOW,
      readFile: (path) => {
        const file = files[path];
        if (!file) throw new Error('ENOENT');
        return file;
      },
      openRegistry: async () => ({ registry, close: async () => { closed += 1; } }),
    });
  return { registry, run, closed: () => closed };
}

describe('O22 governed mapping tool', () => {
  it('a dry run prints the plan with the evidence sha256 and writes nothing', async () => {
    const h = await harness();
    const outcome = await h.run(ARGS);
    expect(outcome).toMatchObject({ exitCode: 0, mode: 'dry_run', reportSha256: SHA, plan: { mapping: { instrumentId: INSTRUMENT.instrumentId, provider: 'etoro', providerSymbol: '100001', validFrom: NOW }, by: { kind: 'human', id: 'operator-1' } } });
    expect(h.registry.mappings()).toEqual([]);
    expect(h.closed()).toBe(1);
  });

  it('--apply without --confirm-human-mapping is refused before the registry is opened', async () => {
    const h = await harness();
    expect(await h.run([...ARGS, APPLY_FLAG])).toEqual({ exitCode: 2, error: 'refused: --apply needs --confirm-human-mapping' });
    expect(h.closed()).toBe(0);
  });

  it('--apply --confirm-human-mapping writes exactly the planned mapping, citing the evidence', async () => {
    const h = await harness();
    const outcome = await h.run([...ARGS, APPLY_FLAG, CONFIRM_MAPPING_FLAG]);
    expect(outcome).toMatchObject({ exitCode: 0, mode: 'applied' });
    expect(h.registry.resolve('etoro', '100001', NOW)).toBe(INSTRUMENT.instrumentId);
    expect(h.registry.mappings(INSTRUMENT.instrumentId)).toHaveLength(1);
    // A second apply is a conflict and writes nothing more.
    expect(await h.run([...ARGS, APPLY_FLAG, CONFIRM_MAPPING_FLAG])).toEqual({ exitCode: 1, error: 'MAPPING_CONFLICT' });
    expect(h.registry.mappings(INSTRUMENT.instrumentId)).toHaveLength(1);
  });

  it('refuses a missing, unreadable, non-JSON, refused or altered report, and an unknown argument', async () => {
    const refused = Buffer.from(JSON.stringify(instrumentMetadataReport({ results: [] })));
    const altered = Buffer.from(JSON.stringify({ ...JSON.parse(REPORT.toString()), metadata: { instrumentId: 100001, type: 'Coin', symbol: 'X', displayName: 'Y' } }));
    const h = await harness({ 'report.json': REPORT, 'refused.json': refused, 'altered.json': altered, 'text.json': Buffer.from('not json') });
    for (const argv of [
      ARGS.filter((a) => !a.startsWith('--metadata-report=')),
      [...ARGS.slice(0, 1), '--metadata-report=missing.json', ...ARGS.slice(2)],
      [...ARGS.slice(0, 1), '--metadata-report=text.json', ...ARGS.slice(2)],
      [...ARGS.slice(0, 1), '--metadata-report=refused.json', ...ARGS.slice(2)],
      [...ARGS.slice(0, 1), '--metadata-report=altered.json', ...ARGS.slice(2)],
      [...ARGS, '--force'],
    ]) {
      expect((await h.run(argv)).exitCode).toBe(2);
    }
    expect(h.registry.mappings()).toEqual([]);
  });

  it('the instrument checks apply (the tool never creates an instrument)', async () => {
    const h = await harness();
    expect(await h.run(['--instrument-id=ins_missing', ...ARGS.slice(1), APPLY_FLAG, CONFIRM_MAPPING_FLAG])).toEqual({ exitCode: 1, error: 'MAPPING_INSTRUMENT_INVALID' });
    expect(await h.run([...ARGS.slice(0, 3), '--operator=two words', APPLY_FLAG, CONFIRM_MAPPING_FLAG])).toEqual({ exitCode: 1, error: 'MAPPING_ACTOR_INVALID' });
    expect(h.registry.mappings()).toEqual([]);
  });

  it('the tool sends no broker request and is not imported by the runtime', () => {
    const text = readFileSync('src/broker/etoro/etoro-map-instrument-cli.ts', 'utf8');
    expect(text).not.toMatch(/Transport|\.call\(|fetch\(/);
    for (const file of ['src/runtime/app.ts', 'src/runtime/services.ts', 'src/runtime/compose.ts', 'src/runtime/bootstrap.ts']) {
      expect(readFileSync(file, 'utf8')).not.toContain('etoro-map-instrument-cli');
    }
  });
});
