// The IBKR routes over HTTP, through the production composition with in-memory stores and the fixture gateway. Checks the
// missing routes [23]-[25], the stable error codes, the explicit mapping, freshness, and that a sync leaves the safety state alone [28].
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRuntimeHandler } from '../../src/runtime/app.js';
import { composeRuntime } from '../../src/runtime/compose.js';
import { startHttpServer, type RunningServer } from '../../src/runtime/server.js';
import { InstrumentRegistry, type InstrumentEvent } from '../../src/market-data/instrument-registry.js';
import { InMemoryMarketDataStore } from '../../src/market-data/market-data-store.js';
import { InMemoryQuantRunStore } from '../../src/quant/quant-run-store.js';
import { AppendOnlyLog, InMemoryAppendOnlyStore } from '../../src/persistence/append-only-log.js';
import type { KillSwitchState } from '../../src/safety/portfolio-safety-envelope.js';
import type { ReconciliationRecord, SnapshotRecord, SyncRecord } from '../../src/broker/ibkr/ibkr-broker-service.js';
import { newEngine, T0 } from '../helpers.js';
import { AAPL } from '../market-data/fixtures.js';
import { FixtureIbkrReadOnlyAdapter, FIXTURE_ACCOUNT, FIXTURE_CONID_AAPL, FIXTURE_SESSION_TOKEN } from '../broker/ibkr/o19-fixture.js';

const change = { at: T0, by: { kind: 'human' as const, id: 'o19-routes' }, reason: 'o19 route fixture' };

interface Harness {
  server: RunningServer;
  base: string;
  fixture: FixtureIbkrReadOnlyAdapter;
  setNow(iso: string): void;
  close(): Promise<void>;
}

async function harness(options: { ibkr: boolean; mapAapl?: boolean }): Promise<Harness> {
  let now = Date.parse(T0);
  const clock = () => new Date(now);
  const instruments = new InMemoryAppendOnlyStore<InstrumentEvent>();
  const registry = await InstrumentRegistry.open(instruments, { clock });
  await registry.register({ ...AAPL }, change);
  if (options.mapAapl !== false) {
    await registry.addMapping({ instrumentId: AAPL.instrumentId, provider: 'ibkr', providerInstrumentId: FIXTURE_CONID_AAPL, providerSymbol: FIXTURE_CONID_AAPL, validFrom: '1980-12-12T00:00:00Z' }, change);
  }
  const { ledger } = await newEngine();
  const fixture = new FixtureIbkrReadOnlyAdapter();
  const services = await composeRuntime({
    instruments,
    marketData: new InMemoryMarketDataStore(),
    quantRuns: new InMemoryQuantRunStore(),
    killSwitch: new InMemoryAppendOnlyStore<KillSwitchState>(),
    provider: null,
    marketDataMode: 'not_configured',
    ping: async () => true,
    version: 'o19-test',
    clock,
    ...(options.ibkr
      ? {
          ibkr: {
            transport: fixture,
            accountId: null,
            accountRef: 'U****567',
            ledger,
            snapshots: await AppendOnlyLog.open<SnapshotRecord>('broker-snapshots', new InMemoryAppendOnlyStore<SnapshotRecord>(), { clock }),
            syncs: await AppendOnlyLog.open<SyncRecord>('broker-sync-events', new InMemoryAppendOnlyStore<SyncRecord>(), { clock }),
            reconciliations: await AppendOnlyLog.open<ReconciliationRecord>('broker-reconciliations', new InMemoryAppendOnlyStore<ReconciliationRecord>(), { clock }),
          },
        }
      : {}),
  });
  const server = await startHttpServer(createRuntimeHandler(services), { host: '127.0.0.1', port: 0 });
  return {
    server,
    base: server.url,
    fixture,
    setNow: (iso: string) => (now = Date.parse(iso)),
    close: () => server.close(),
  };
}

async function call(base: string, method: string, path: string, body?: unknown): Promise<{ status: number; text: string; json: Record<string, unknown> }> {
  // A GET cannot carry a body; the probe sends one only where the method allows it.
  const sendBody = method !== 'GET' && body !== undefined;
  const response = await fetch(base + path, { method, headers: sendBody ? { 'content-type': 'application/json' } : undefined, body: sendBody ? JSON.stringify(body) : undefined });
  const text = await response.text();
  return { status: response.status, text, json: text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

describe('O19 broker routes: the execution routes do not exist', () => {
  beforeEach(async () => {
    h = await harness({ ibkr: true });
  });

  it('[23][24][25] there is no route to place or order anything, and each of them answers 404 for every method', async () => {
    for (const path of ['/api/broker/place', '/api/broker/ibkr/order', '/api/broker/ibkr/orders', '/api/broker/ibkr/place']) {
      for (const method of ['GET', 'POST']) expect((await call(h!.base, method, path, {})).status).toBe(404);
    }
  });

  it('no reset, unlock, arm, enable-live or safety-reset route exists for the broker either', async () => {
    for (const path of ['/reset', '/unlock', '/arm', '/enable-live', '/api/safety/reset', '/api/broker/ibkr/reset']) {
      expect((await call(h!.base, 'POST', path, {})).status).toBe(404);
    }
  });
});

describe('O19 broker routes: status, sync, snapshot and reconciliation', () => {
  beforeEach(async () => {
    h = await harness({ ibkr: true });
  });

  it('health reports the broker read-only and never the account', async () => {
    const health = await call(h!.base, 'GET', '/health');
    expect(health.json).toMatchObject({ broker: { ibkr: { configured: true, connection: 'not_connected', access: 'read_only' } } });
    expect(health.text).not.toContain(FIXTURE_ACCOUNT);
  });

  it('a sync reads, stores and reconciles; the snapshot shows the masked account only', async () => {
    const sync = await call(h!.base, 'POST', '/api/broker/ibkr/sync');
    expect(sync.status).toBe(200);
    expect(sync.json).toMatchObject({ snapshot: { freshness: 'fresh' }, reconciliation: { stale: false, matched: false } });
    const snapshot = await call(h!.base, 'GET', '/api/broker/ibkr/snapshot');
    expect(snapshot.json).toMatchObject({ snapshot: { content: { accountRef: 'U****567', access: 'read_only' } } });
    expect(snapshot.text).not.toContain(FIXTURE_ACCOUNT);
    expect(snapshot.text).not.toContain(FIXTURE_SESSION_TOKEN);
  });

  it('[28] a sync does not change the safety status: the kill switch reads the same before and after', async () => {
    const before = await call(h!.base, 'GET', '/api/safety/status');
    await call(h!.base, 'POST', '/api/broker/ibkr/sync');
    const after = await call(h!.base, 'GET', '/api/safety/status');
    expect(after.text).toBe(before.text);
    expect(after.json).toMatchObject({ canIncreaseRisk: false, liveTradingAllowed: false });
  });

  it('a stale reconciliation is shown with stale=true, and requireFresh=1 refuses it with BROKER_SNAPSHOT_STALE', async () => {
    await call(h!.base, 'POST', '/api/broker/ibkr/sync');
    h!.setNow('2026-10-15T09:30:00.000Z');
    const shown = await call(h!.base, 'GET', '/api/broker/ibkr/reconciliation');
    expect(shown.json).toMatchObject({ reconciliation: { stale: true, freshness: 'stale' } });
    const refused = await call(h!.base, 'GET', '/api/broker/ibkr/reconciliation?requireFresh=1');
    expect(refused.status).toBe(409);
    expect(refused.json).toMatchObject({ error: { code: 'BROKER_SNAPSHOT_STALE' } });
  });

  it('the requireFresh flag accepts only 0 or 1', async () => {
    expect((await call(h!.base, 'GET', '/api/broker/ibkr/reconciliation?requireFresh=yes')).status).toBe(400);
  });

  it('before the first sync the snapshot is null and the reconciliation is null: nothing is invented', async () => {
    expect(await call(h!.base, 'GET', '/api/broker/ibkr/snapshot')).toMatchObject({ status: 200, json: { snapshot: null } });
    expect(await call(h!.base, 'GET', '/api/broker/ibkr/reconciliation')).toMatchObject({ status: 200, json: { reconciliation: null } });
  });

  it('[18] a repeated sync of an identical state answers the same snapshot id', async () => {
    const first = await call(h!.base, 'POST', '/api/broker/ibkr/sync');
    h!.setNow('2026-10-15T09:00:10.000Z');
    const second = await call(h!.base, 'POST', '/api/broker/ibkr/sync');
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect((first.json.snapshot as { snapshotId: string }).snapshotId).toBe((second.json.snapshot as { snapshotId: string }).snapshotId);
  });

  it('an authentication failure is a clean 503 with a stable code, and the session token is not in the response', async () => {
    h!.fixture.fail('session.tickle', { status: 401, body: null });
    const sync = await call(h!.base, 'POST', '/api/broker/ibkr/sync');
    expect(sync.status).toBe(503);
    expect(sync.json).toMatchObject({ error: { code: 'BROKER_AUTH_REQUIRED' } });
    expect(sync.text).not.toContain(FIXTURE_SESSION_TOKEN);
  });
});

describe('O19 broker routes: the explicit instrument mapping', () => {
  it('an unmapped contract is shown as unmapped; the mapping route links it; the next sync resolves it', async () => {
    h = await harness({ ibkr: true, mapAapl: false });
    const first = await call(h.base, 'POST', '/api/broker/ibkr/sync');
    expect(first.status).toBe(200);
    expect(first.text).toContain('unmapped_broker_instrument');
    const mapped = await call(h.base, 'POST', '/api/broker/ibkr/mappings', { conid: FIXTURE_CONID_AAPL, instrumentId: 'ins_aapl', validFrom: '1980-12-12T00:00:00.000Z' });
    expect(mapped).toMatchObject({ status: 200, json: { status: 'MAPPED', instrumentId: 'ins_aapl' } });
    h.setNow('2026-10-15T09:00:10.000Z');
    const second = await call(h.base, 'POST', '/api/broker/ibkr/sync');
    // The status is checked first: a throttled or failed sync must not pass as "no unmapped line".
    expect(second.status).toBe(200);
    expect(second.text).not.toContain('unmapped_broker_instrument');
  });

  it('the mapping body is strict: unknown fields, a non-digit conid and a non-canonical date are refused', async () => {
    h = await harness({ ibkr: true, mapAapl: false });
    expect((await call(h.base, 'POST', '/api/broker/ibkr/mappings', { conid: FIXTURE_CONID_AAPL, instrumentId: 'ins_aapl', validFrom: '1980-12-12T00:00:00.000Z', ticker: 'AAPL' })).status).toBe(400);
    expect((await call(h.base, 'POST', '/api/broker/ibkr/mappings', { conid: 'AAPL', instrumentId: 'ins_aapl', validFrom: '1980-12-12T00:00:00.000Z' })).status).toBe(400);
    expect((await call(h.base, 'POST', '/api/broker/ibkr/mappings', { conid: FIXTURE_CONID_AAPL, instrumentId: 'ins_aapl', validFrom: '1980-12-12T00:00:00Z' })).status).toBe(400);
  });

  it('mapping an unknown NEXUS instrument is refused with a stable code', async () => {
    h = await harness({ ibkr: true, mapAapl: false });
    await call(h.base, 'POST', '/api/broker/ibkr/sync');
    const refused = await call(h.base, 'POST', '/api/broker/ibkr/mappings', { conid: FIXTURE_CONID_AAPL, instrumentId: 'ins_missing', validFrom: '1980-12-12T00:00:00.000Z' });
    expect(refused.status).toBe(409);
    expect(refused.json).toMatchObject({ error: { code: 'BROKER_INSTRUMENT_UNMAPPED' } });
  });
});

describe('O19 broker routes: not configured means not connected, never a fake snapshot', () => {
  it('with IBKR disabled, status says not connected, and the broker routes answer BROKER_NOT_CONNECTED', async () => {
    h = await harness({ ibkr: false });
    expect(await call(h.base, 'GET', '/api/broker/ibkr/status')).toMatchObject({ status: 200, json: { ibkr: { configured: false, connection: 'not_connected', access: 'read_only' } } });
    expect(await call(h.base, 'POST', '/api/broker/ibkr/sync')).toMatchObject({ status: 503, json: { error: { code: 'BROKER_NOT_CONNECTED' } } });
    expect(await call(h.base, 'GET', '/api/broker/ibkr/snapshot')).toMatchObject({ status: 503, json: { error: { code: 'BROKER_NOT_CONNECTED' } } });
    expect(await call(h.base, 'GET', '/api/broker/ibkr/reconciliation')).toMatchObject({ status: 503, json: { error: { code: 'BROKER_NOT_CONNECTED' } } });
    expect(h.fixture.calls).toHaveLength(0);
  });
});
