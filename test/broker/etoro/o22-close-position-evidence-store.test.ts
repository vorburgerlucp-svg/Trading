// O22 D4, review of PR #31 (R1, R2): the evidence of a close is read from the STORE, with the records of every process, and read
// again right before the reservation. R1: EtoroBrokerService.latestStoredSnapshot() catches up with the sync and snapshot logs and
// refuses to name a snapshot when the store cannot name one newest observation. R2: a newer snapshot stored between the gate and
// the reservation is seen. No network: fixture transports and scripted broker answers. PostgreSQL: o22-close-position-evidence-runtime.pg.test.ts.
import { describe, expect, it, vi } from 'vitest';

// TEST ONLY: this module exercises the write path, so it replaces the compile-time lock for this module only.
vi.mock('../../../src/nexus/safety.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/nexus/safety.js')>();
  return { ...actual, BUILD_LOCKS: Object.freeze({ ...actual.BUILD_LOCKS, etoroDemoExecution: false }) };
});
import { AppendOnlyLog, InMemoryAppendOnlyStore } from '../../../src/persistence/append-only-log.js';
import { EtoroBrokerService, type EtoroReconciliationRecord, type EtoroSnapshotRecord, type EtoroSyncRecord } from '../../../src/broker/etoro/etoro-broker-service.js';
import { EtoroBrokerSyncAdapter } from '../../../src/broker/etoro/etoro-sync-adapter.js';
import { DEFAULT_DEMO_EXECUTION_POLICY, closePositionRefusals, type ClosePositionEvidence } from '../../../src/broker/etoro/execution/execution-gate.js';
import { parseExecutionIntent } from '../../../src/broker/etoro/execution/execution-intent.js';
import { storedPositionSource } from '../../../src/runtime/demo-execution-sources.js';
import { FixtureEtoroTransport, emptyDemoPortfolio } from './o20-fixture.js';
import { documentedPortfolio, documentedPosition } from './o21a-documented-fixture.js';
import { CREATOR, DEFAULT_BROKER_POSITION, ETORO_AAPL_ID, HUMAN, closeInput, filledOpen, o21Fixture, type Fixture } from './o21-fixture.js';
import { refusal } from './o22-recovery-scenarios.js';

const POSITION = DEFAULT_BROKER_POSITION.positionId;
const T0 = '2026-10-16T14:00:00.000Z';
const withPosition = () => documentedPortfolio({ positions: [documentedPosition({ positionID: POSITION, instrumentID: ETORO_AAPL_ID, isBuy: true, orderID: 13902598, orderType: 17 })] });

interface Stores {
  snapshots: InMemoryAppendOnlyStore<EtoroSnapshotRecord>;
  reconciliations: InMemoryAppendOnlyStore<EtoroReconciliationRecord>;
  syncs: InMemoryAppendOnlyStore<EtoroSyncRecord>;
}

function sharedStores(): Stores {
  return { snapshots: new InMemoryAppendOnlyStore(), reconciliations: new InMemoryAppendOnlyStore(), syncs: new InMemoryAppendOnlyStore() };
}

/** One process: its own logs (own in-memory copies) over the shared store, its own clock and portfolio transport. */
async function etoroProcess(stores: Stores, at = T0) {
  const clock = { now: new Date(at) };
  const now = () => new Date(clock.now.getTime());
  const portfolio = new FixtureEtoroTransport();
  const syncs = await AppendOnlyLog.open<EtoroSyncRecord>('etoro-sync-events', stores.syncs, { clock: now });
  const service = new EtoroBrokerService({
    adapter: new EtoroBrokerSyncAdapter({ transport: portfolio, clock: now }),
    ledger: { balances: () => new Map() },
    snapshots: await AppendOnlyLog.open<EtoroSnapshotRecord>('etoro-snapshots', stores.snapshots, { clock: now }),
    reconciliations: await AppendOnlyLog.open<EtoroReconciliationRecord>('etoro-reconciliations', stores.reconciliations, { clock: now }),
    syncs,
    clock: now,
  });
  return { service, portfolio, clock, syncs };
}

describe('O22 D4 R1: latestStoredSnapshot reads the store, with every process\'s records', () => {
  it('a newer snapshot stored by another process is seen; the not caught-up local copy (latestSnapshot) is not used', async () => {
    const stores = sharedStores();
    const a = await etoroProcess(stores);
    const b = await etoroProcess(stores, '2026-10-16T14:01:00.000Z');
    a.portfolio.response = { status: 200, body: withPosition() };
    await a.service.sync();
    b.portfolio.response = { status: 200, body: emptyDemoPortfolio() };
    await b.service.sync();
    expect((await a.service.latestSnapshot())?.content.positionCount).toBe(1);
    const read = await a.service.latestStoredSnapshot();
    expect(read.kind).toBe('snapshot');
    expect(read.kind === 'snapshot' && read.snapshot.observedAt).toBe('2026-10-16T14:01:00.000Z');
    expect(read.kind === 'snapshot' && read.snapshot.content.positionCount).toBe(0);
  });

  it('no successful sync at all: none', async () => {
    expect(await (await etoroProcess(sharedStores())).service.latestStoredSnapshot()).toEqual({ kind: 'none' });
  });

  it('two successful syncs with the same observedAt and different contents: ambiguous', async () => {
    const stores = sharedStores();
    const a = await etoroProcess(stores);
    const b = await etoroProcess(stores);
    a.portfolio.response = { status: 200, body: withPosition() };
    await a.service.sync();
    b.portfolio.response = { status: 200, body: emptyDemoPortfolio() };
    await b.service.sync();
    expect(await a.service.latestStoredSnapshot()).toEqual({ kind: 'ambiguous' });
  });

  it('the same content observed twice at the same time is not ambiguous (one snapshot)', async () => {
    const stores = sharedStores();
    const a = await etoroProcess(stores);
    const b = await etoroProcess(stores);
    a.portfolio.response = { status: 200, body: withPosition() };
    b.portfolio.response = { status: 200, body: withPosition() };
    await a.service.sync();
    await b.service.sync();
    expect((await a.service.latestStoredSnapshot()).kind).toBe('snapshot');
  });

  it('the newest successful sync names a snapshot record that cannot be read: unreadable', async () => {
    const stores = sharedStores();
    const a = await etoroProcess(stores);
    a.portfolio.response = { status: 200, body: withPosition() };
    await a.service.sync();
    const observedAt = '2026-10-16T14:00:30.000Z';
    await a.syncs.append('esync_missing', { schema: 'etoro-sync:v1', syncId: 'esync_missing', outcome: 'success', snapshotId: 'esnap_missing', reconciliationId: 'erec_missing', observedAt, retrievedAt: observedAt });
    expect(await a.service.latestStoredSnapshot()).toEqual({ kind: 'unreadable' });
  });

  it('O22 Plan B review R2: the newest snapshot whose content contradicts its counts or its id is not used: inconsistent', async () => {
    const stores = sharedStores();
    const a = await etoroProcess(stores);
    a.portfolio.response = { status: 200, body: withPosition() };
    await a.service.sync();
    const good = (await a.service.latestStoredSnapshot()) as { kind: 'snapshot'; snapshot: { content: EtoroSnapshotRecord['content'] } };
    const snapshots = await AppendOnlyLog.open<EtoroSnapshotRecord>('etoro-snapshots', stores.snapshots);
    const observedAt = '2026-10-16T14:00:30.000Z';
    // A stored record whose stated count does not match its list (and whose id is therefore not its content hash).
    const content = { ...good.snapshot.content, positionCount: 0 };
    await snapshots.append('esnap_' + 'e'.repeat(40), { schema: 'etoro-snapshot:v1', snapshotId: 'esnap_' + 'e'.repeat(40), content });
    await a.syncs.append('esync_bad', { schema: 'etoro-sync:v1', syncId: 'esync_bad', outcome: 'success', snapshotId: 'esnap_' + 'e'.repeat(40), reconciliationId: 'erec_bad', observedAt, retrievedAt: observedAt });
    expect(await a.service.latestStoredSnapshot()).toEqual({ kind: 'inconsistent' });
    expect(await storedPositionSource(a.service).latest()).toEqual({ snapshot: null, problem: 'inconsistent' });
  });

  it('storedPositionSource maps the stored snapshot (position, instrument, direction, opening order) and passes problems on', async () => {
    const stores = sharedStores();
    const a = await etoroProcess(stores);
    expect(await storedPositionSource(null).latest()).toEqual({ snapshot: null, problem: null });
    expect(await storedPositionSource(a.service).latest()).toEqual({ snapshot: null, problem: null });
    a.portfolio.response = { status: 200, body: withPosition() };
    await a.service.sync();
    expect(await storedPositionSource(a.service).latest()).toEqual({
      snapshot: { observedAt: T0, freshness: 'fresh', positionCount: 1, positions: [{ positionId: POSITION, etoroInstrumentId: ETORO_AAPL_ID, direction: 'buy', openOrderId: 13902598 }] },
      problem: null,
    });
    expect(await storedPositionSource({ latestStoredSnapshot: async () => ({ kind: 'ambiguous' }) }).latest()).toEqual({ snapshot: null, problem: 'ambiguous' });
    expect(await storedPositionSource({ latestStoredSnapshot: async () => ({ kind: 'unreadable' }) }).latest()).toEqual({ snapshot: null, problem: 'unreadable' });
  });

  it('a problem refuses the close whatever the snapshot says', () => {
    const intent = { ...parseExecutionIntent(closeInput('eint_' + 'a'.repeat(40)), CREATOR), positionId: POSITION };
    const base: ClosePositionEvidence = {
      snapshot: { observedAt: '2026-10-16T13:59:30.000Z', freshness: 'fresh', positionCount: 1, positions: [DEFAULT_BROKER_POSITION] },
      boundAt: '2026-10-16T13:59:00.000Z',
      openOrderId: 13902598,
    };
    expect(closePositionRefusals(intent, base, T0, DEFAULT_DEMO_EXECUTION_POLICY)).toEqual([]);
    expect(closePositionRefusals(intent, { ...base, problem: 'ambiguous' }, T0, DEFAULT_DEMO_EXECUTION_POLICY)).toEqual(['CLOSE_POSITION_EVIDENCE_AMBIGUOUS']);
    expect(closePositionRefusals(intent, { ...base, problem: 'unreadable' }, T0, DEFAULT_DEMO_EXECUTION_POLICY)).toEqual(['CLOSE_POSITION_EVIDENCE_UNREADABLE']);
    expect(closePositionRefusals(intent, { ...base, problem: 'inconsistent' }, T0, DEFAULT_DEMO_EXECUTION_POLICY)).toEqual(['CLOSE_POSITION_EVIDENCE_INCONSISTENT']);
  });
});

describe('O22 D4 R2: the evidence is read again right before the reservation', () => {
  async function approvedClose(f: Fixture): Promise<string> {
    const open = await filledOpen(f, POSITION);
    const created = await f.service.create(closeInput(open), CREATOR);
    expect(created.state, created.gateReasons.join(',')).toBe('RISK_APPROVED');
    await f.service.approve(created.intentId, HUMAN);
    return created.intentId;
  }

  it('the position disappears from the stored snapshot between the gate and the reservation: refused, no write, no budget', async () => {
    // The request id is taken after the gate and before the reservation: the stored snapshot changes exactly there.
    let armed = false;
    const holder: { f?: Fixture } = {};
    const f = await o21Fixture({ requestId: () => {
      if (armed) holder.f!.setSnapshot({ positions: [] });
      return '00000000-0000-4000-8000-0000000000aa';
    } });
    holder.f = f;
    const close = await approvedClose(f);
    armed = true;
    const e = await refusal(f.service.execute(close, HUMAN));
    expect(e).toEqual({ code: 'GATE_REFUSED', reasons: ['CLOSE_POSITION_NOT_OPEN_AT_BROKER'] });
    expect((await f.service.get(close)).state).toBe('APPROVED');
    expect(f.broker.writes).toHaveLength(1);
    expect(await f.service.cycleBudget()).toMatchObject({ closeSubmissions: 0 });
  });

  it('the store turns ambiguous between the gate and the reservation: refused in the reservation step', async () => {
    let reads = 0;
    const f = await o21Fixture({ positionSource: { latest: async () => {
      reads += 1;
      if (reads >= 3) return { snapshot: null, problem: 'ambiguous' as const }; // read 1: create, 2: execute gate, 3: reservation
      return { snapshot: { observedAt: '2026-10-16T14:00:00.000Z', freshness: 'fresh' as const, positionCount: 1, positions: [DEFAULT_BROKER_POSITION] }, problem: null };
    } } });
    const close = await approvedClose(f);
    const e = await refusal(f.service.execute(close, HUMAN));
    expect(e).toEqual({ code: 'GATE_REFUSED', reasons: ['CLOSE_POSITION_EVIDENCE_AMBIGUOUS'] });
    expect(reads).toBe(3);
    expect(f.broker.writes).toHaveLength(1);
    expect(await f.service.cycleBudget()).toMatchObject({ closeSubmissions: 0 });
  });

  it('an open never reads the position evidence', async () => {
    let reads = 0;
    const f = await o21Fixture({ positionSource: { latest: async () => {
      reads += 1;
      return { snapshot: null, problem: null };
    } } });
    await filledOpen(f, POSITION);
    expect(reads).toBe(0);
  });
});
