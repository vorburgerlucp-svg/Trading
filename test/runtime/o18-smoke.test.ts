// Runtime smoke test: start the real HTTP server over the production composition, call the endpoints in order, shut down.
// The stores are in-memory here. The same path over PostgreSQL is covered by test/pg/o18-runtime.pg.test.ts.
import { describe, expect, it } from 'vitest';
import type { InstrumentEvent } from '../../src/market-data/instrument-registry.js';
import { InMemoryMarketDataStore } from '../../src/market-data/market-data-store.js';
import { InMemoryQuantRunStore } from '../../src/quant/quant-run-store.js';
import { InMemoryAppendOnlyStore } from '../../src/persistence/append-only-log.js';
import type { KillSwitchState } from '../../src/safety/portfolio-safety-envelope.js';
import { createRuntimeHandler } from '../../src/runtime/app.js';
import { composeRuntime } from '../../src/runtime/compose.js';
import { startHttpServer } from '../../src/runtime/server.js';
import { AAPL, FIXTURE_SOURCE } from '../market-data/fixtures.js';
import { RUNTIME_TEST_NOW, fixtureProvider, registerAapl } from './o18-fixtures.js';

describe('O18 runtime smoke: start, health, search, bars, quant, safety, shutdown', () => {
  it('runs the whole local path over the production composition and shuts down cleanly', async () => {
    const instruments = new InMemoryAppendOnlyStore<InstrumentEvent>();
    await registerAapl(instruments);

    const services = await composeRuntime({
      instruments,
      marketData: new InMemoryMarketDataStore(),
      quantRuns: new InMemoryQuantRunStore(),
      killSwitch: new InMemoryAppendOnlyStore<KillSwitchState>(),
      provider: fixtureProvider(),
      marketDataMode: 'demo',
      ping: async () => true,
      version: 'smoke',
      clock: () => new Date(RUNTIME_TEST_NOW),
    });
    const server = await startHttpServer(createRuntimeHandler(services), { host: '127.0.0.1', port: 0 });
    try {
      const health = await fetch(server.url + '/health');
      expect(health.status).toBe(200);
      expect(await health.json()).toMatchObject({ status: 'ok', tradingMode: 'paper', liveTrading: 'locked', marketData: 'demo' });

      const search = await (await fetch(server.url + '/api/instruments/search?q=AAPL')).json() as { instruments: Array<{ providerSymbol: string; instrumentId: string | null }> };
      expect(search.instruments[0]).toMatchObject({ providerSymbol: 'AAPL', instrumentId: AAPL.instrumentId });

      const barsResponse = await fetch(server.url + '/api/market/bars?instrumentId=' + AAPL.instrumentId + '&interval=1d&from=2026-08-01T00:00:00.000Z&to=2026-10-14T00:00:00.000Z');
      expect(barsResponse.status).toBe(200);
      const bars = await barsResponse.json() as { bars: Array<{ isFinal: boolean; source: string }>; usableForTrading: boolean; dataMode: string };
      expect(bars.bars.length).toBeGreaterThan(0);
      expect(bars.bars.every((bar) => bar.isFinal && bar.source === FIXTURE_SOURCE.sourceId)).toBe(true);
      expect(bars.dataMode).toBe('demo');
      expect(bars.usableForTrading).toBe(false);

      const quant = await fetch(server.url + '/api/quant/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ instrumentId: AAPL.instrumentId, interval: '1d', asOf: RUNTIME_TEST_NOW }),
      });
      expect(quant.status).toBe(200);
      const run = await quant.json() as { quantRunId: string; insufficientData: boolean };
      expect(run.quantRunId).toMatch(/^qr_[0-9a-f]{40}$/);
      expect(typeof run.insufficientData).toBe('boolean');

      const safety = await (await fetch(server.url + '/api/safety/status')).json() as Record<string, unknown>;
      expect(safety).toMatchObject({ canIncreaseRisk: false, canReduceRisk: true, liveTradingAllowed: false });
    } finally {
      await server.close();
    }
    await expect(fetch(server.url + '/health')).rejects.toBeDefined();
  });
});
