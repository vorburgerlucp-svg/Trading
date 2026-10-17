// O21A runtime: the production composition with eToro read-only and O21 demo execution both on, a non-empty demo portfolio
// (DOCUMENTED fixture, not live-observed) synced over real HTTP. The snapshot carries the mapped position; the ledger, the kill
// switch, every O21 execution log and the build locks are unchanged; the execution transport sends nothing; no real endpoint exists.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CapitalLedger } from '../../src/capital/capital-ledger.js';
import { InstrumentRegistry, type InstrumentEvent } from '../../src/market-data/instrument-registry.js';
import { InMemoryMarketDataStore } from '../../src/market-data/market-data-store.js';
import { InMemoryQuantRunStore } from '../../src/quant/quant-run-store.js';
import { AppendOnlyLog, InMemoryAppendOnlyStore } from '../../src/persistence/append-only-log.js';
import type { KillSwitchState } from '../../src/safety/portfolio-safety-envelope.js';
import type { EtoroReconciliationRecord, EtoroSnapshotRecord, EtoroSyncRecord } from '../../src/broker/etoro/etoro-broker-service.js';
import { HttpsDemoExecutionTransport } from '../../src/broker/etoro/execution/etoro-demo-execution-transport.js';
import type { AttemptRecord, ConfirmationRecord, IntentEvent, ReconciliationRecord } from '../../src/broker/etoro/execution/etoro-demo-execution-service.js';
import { BUILD_LOCKS, loadSafetyConfig } from '../../src/nexus/safety.js';
import { createRuntimeHandler } from '../../src/runtime/app.js';
import { composeRuntime } from '../../src/runtime/compose.js';
import { OperatorAuthenticator } from '../../src/runtime/operator-auth.js';
import { startHttpServer, type RunningServer } from '../../src/runtime/server.js';
import { AAPL } from '../market-data/fixtures.js';
import { FixtureEtoroTransport } from '../broker/etoro/o20-fixture.js';
import { API_KEY_MARKER, O21_NOW, ScriptedBroker, USER_KEY_MARKER } from '../broker/etoro/o21-fixture.js';
import { documentedPortfolio } from '../broker/etoro/o21a-documented-fixture.js';

let server: RunningServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

async function runtime() {
  const now = () => new Date(O21_NOW);
  const instruments = new InMemoryAppendOnlyStore<InstrumentEvent>();
  const registry = await InstrumentRegistry.open(instruments, { clock: now });
  const change = { at: '2026-10-01T00:00:00.000Z', by: { kind: 'human' as const, id: 'mapping-owner' }, reason: 'O21A runtime test: governed eToro mapping' };
  await registry.register({ ...AAPL }, change);
  // The documented example position is instrument 1002.
  await registry.addMapping({ instrumentId: AAPL.instrumentId, provider: 'etoro', providerSymbol: '1002', validFrom: '2026-10-01T00:00:00.000Z' }, change);

  const ledger = await CapitalLedger.inMemory();
  const readOnly = new FixtureEtoroTransport();
  readOnly.response = { status: 200, body: documentedPortfolio() };
  const broker = new ScriptedBroker();
  const killSwitch = new InMemoryAppendOnlyStore<KillSwitchState>();
  const logs = {
    intents: await AppendOnlyLog.inMemory<IntentEvent>('etoro-demo-execution-intents', { clock: now }),
    attempts: await AppendOnlyLog.inMemory<AttemptRecord>('etoro-demo-execution-attempts', { clock: now }),
    confirmations: await AppendOnlyLog.inMemory<ConfirmationRecord>('etoro-demo-broker-confirmations', { clock: now }),
    reconciliations: await AppendOnlyLog.inMemory<ReconciliationRecord>('etoro-demo-execution-reconciliations', { clock: now }),
  };
  const services = await composeRuntime({
    instruments,
    marketData: new InMemoryMarketDataStore(),
    quantRuns: new InMemoryQuantRunStore(),
    killSwitch,
    provider: null,
    marketDataMode: 'not_configured',
    ping: async () => true,
    version: 'o21a-test',
    clock: now,
    etoro: {
      transport: readOnly,
      ledger,
      snapshots: await AppendOnlyLog.inMemory<EtoroSnapshotRecord>('etoro-snapshots', { clock: now }),
      reconciliations: await AppendOnlyLog.inMemory<EtoroReconciliationRecord>('etoro-reconciliations', { clock: now }),
      syncs: await AppendOnlyLog.inMemory<EtoroSyncRecord>('etoro-sync-events', { clock: now }),
    },
    etoroDemoExecution: {
      transport: new HttpsDemoExecutionTransport({ credentials: { apiKey: API_KEY_MARKER, userKey: USER_KEY_MARKER }, fetch: broker.fetch }),
      ...logs,
    },
  });
  server = await startHttpServer(createRuntimeHandler(services, { operatorAuth: new OperatorAuthenticator({ id: 'op', token: 'O21A-OPERATOR-TOKEN-0123456789abcdef' }) }), { host: '127.0.0.1', port: 0 });
  return { base: server.url, readOnly, broker, ledger, killSwitch, logs, registry };
}

describe('O21A runtime: a non-empty demo portfolio through the production composition', () => {
  it('sync stores the mapped position; ledger, kill switch, execution logs, build locks unchanged; no broker write', async () => {
    const r = await runtime();
    const ledgerBefore = r.ledger.size;
    const killSwitchBefore = (await r.killSwitch.loadAll()).length;
    const mappingsBefore = r.registry.mappings().length;

    const res = await fetch(r.base + '/api/broker/etoro/sync', { method: 'POST' });
    const text = await res.text();
    expect(res.status, text).toBe(200);
    const json = JSON.parse(text);
    expect(json.snapshot.content).toMatchObject({ positionCount: 1, openOrderCount: 1, coverage: { cash: 'not_read', positions: 'documented_schema' } });
    expect(json.snapshot.content.positions[0]).toMatchObject({ etoroInstrumentId: 1002, instrumentId: AAPL.instrumentId });
    // The empty ledger does not hold the broker position: reported, nothing booked.
    expect(json.reconciliation.issues).toEqual([{ kind: 'missing_in_ledger', instrumentId: AAPL.instrumentId, broker: '0.049485' }]);

    expect(r.ledger.size).toBe(ledgerBefore);
    expect((await r.killSwitch.loadAll()).length).toBe(killSwitchBefore);
    for (const log of Object.values(r.logs)) expect(log.size).toBe(0);
    expect(r.registry.mappings().length).toBe(mappingsBefore);
    expect(r.broker.requests).toEqual([]);
    expect(r.readOnly.calls).toEqual(['portfolio.demo']);
    expect(text).not.toContain(API_KEY_MARKER);
    expect(text).not.toContain(USER_KEY_MARKER);

    expect(BUILD_LOCKS).toEqual({ liveTrading: true, brokerOrders: true, physicalPurchase: true, etoroDemoExecution: true });
    expect(loadSafetyConfig({ TRADING_MODE: 'paper', ALLOW_LIVE_TRADING: 'false' })).toEqual({ tradingMode: 'paper', allowLiveTrading: false });
  });

  it('no real-account endpoint exists anywhere in the eToro sources', () => {
    const files = ['src/broker/etoro', 'src/broker/etoro/execution'].flatMap((dir) => readdirSync(dir).filter((f) => f.endsWith('.ts')).map((f) => join(dir, f)));
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      expect(text, file).not.toMatch(/\/trading\/info\/real\b|\/trading\/execution\/(?!demo\b)|\/real\//);
    }
  });
});
