// O22 Plan B TEST ONLY: one NEXUS process with the external closure wiring of the runtime: the demo execution service (o21Fixture),
// its own EtoroBrokerService over the O20 logs, storedPositionSource for the gate, and the stored sync history for the attestation.
// The stores are passed in, so several processes can share them (in memory, or PostgreSQL in the pg tests). The portfolio reads go
// to a fixture transport: no network, no broker.
import { AppendOnlyLog, InMemoryAppendOnlyStore, type AppendOnlyStore } from '../../../src/persistence/append-only-log.js';
import { EtoroBrokerService, type EtoroReconciliationRecord, type EtoroSnapshotRecord, type EtoroSyncRecord } from '../../../src/broker/etoro/etoro-broker-service.js';
import { EtoroBrokerSyncAdapter } from '../../../src/broker/etoro/etoro-sync-adapter.js';
import { EXTERNAL_CLOSURE_STATEMENT, type ExternalClosureRecord } from '../../../src/broker/etoro/execution/external-closure.js';
import type { DemoExecutionPolicy } from '../../../src/broker/etoro/execution/execution-gate.js';
import { storedPositionSource } from '../../../src/runtime/demo-execution-sources.js';
import { FixtureEtoroTransport, emptyDemoPortfolio } from './o20-fixture.js';
import { documentedOrder, documentedPortfolio, documentedPosition } from './o21a-documented-fixture.js';
import { ETORO_AAPL_ID, HUMAN, ScriptedBroker, filledOpen, inMemoryStores, o21Fixture, type Fixture, type O21Stores } from './o21-fixture.js';

export const POSITION = 2150941015;
/** The order id filledOpen() gets from the broker. */
export const OPEN_ORDER = 13902598;

export interface EtoroStores {
  snapshots: AppendOnlyStore<EtoroSnapshotRecord>;
  reconciliations: AppendOnlyStore<EtoroReconciliationRecord>;
  syncs: AppendOnlyStore<EtoroSyncRecord>;
}

export function inMemoryEtoroStores(): EtoroStores {
  return { snapshots: new InMemoryAppendOnlyStore(), reconciliations: new InMemoryAppendOnlyStore(), syncs: new InMemoryAppendOnlyStore() };
}

export type Portfolio = 'with_position' | 'without_position' | 'with_open_order' | 'other_position';

export function portfolioBody(kind: Portfolio): Record<string, unknown> {
  const position = documentedPosition({ positionID: POSITION, instrumentID: ETORO_AAPL_ID, isBuy: true, orderID: OPEN_ORDER, orderType: 17 });
  switch (kind) {
    case 'with_position':
      return documentedPortfolio({ positions: [position] });
    case 'without_position':
      return emptyDemoPortfolio();
    case 'with_open_order':
      return documentedPortfolio({ orders: [documentedOrder({ orderID: OPEN_ORDER, instrumentID: ETORO_AAPL_ID })] });
    case 'other_position':
      return documentedPortfolio({ positions: [documentedPosition({ positionID: 2150999999, instrumentID: ETORO_AAPL_ID, isBuy: true, orderID: 13999999, orderType: 17 })] });
  }
}

export interface ClosureProcess {
  f: Fixture;
  etoro: EtoroBrokerService;
  syncs: AppendOnlyLog<EtoroSyncRecord>;
  /** A read-only portfolio read stored by this process (fixture transport); returns the stored snapshot id. */
  sync(kind: Portfolio): Promise<string>;
  /** The operator's claim for the open (overrides change single fields, for the refusal tests). */
  attest(openIntentId: string, snapshotId: string, overrides?: Record<string, unknown>, by?: unknown): Promise<ExternalClosureRecord>;
}

export async function closureProcess(options: {
  stores?: O21Stores;
  etoroStores?: EtoroStores;
  closures?: AppendOnlyStore<ExternalClosureRecord>;
  broker?: ScriptedBroker;
  policy?: DemoExecutionPolicy;
} = {}): Promise<ClosureProcess> {
  const etoroStores = options.etoroStores ?? inMemoryEtoroStores();
  const holder: { etoro: EtoroBrokerService | null } = { etoro: null };
  const f = await o21Fixture({
    stores: options.stores ?? inMemoryStores(),
    ...(options.broker !== undefined ? { sharedBroker: options.broker } : {}),
    ...(options.policy !== undefined ? { policy: options.policy } : {}),
    externalClosures: options.closures ?? new InMemoryAppendOnlyStore<ExternalClosureRecord>(),
    snapshotHistory: { history: () => holder.etoro!.snapshotHistory() },
    positionSource: { latest: () => storedPositionSource(holder.etoro).latest() },
  });
  const clock = () => new Date(f.clock.now.getTime());
  const portfolio = new FixtureEtoroTransport();
  const syncs = await AppendOnlyLog.open<EtoroSyncRecord>('etoro-sync-events', etoroStores.syncs, { clock });
  const etoro = new EtoroBrokerService({
    adapter: new EtoroBrokerSyncAdapter({ transport: portfolio, clock }),
    ledger: { balances: () => new Map() },
    snapshots: await AppendOnlyLog.open<EtoroSnapshotRecord>('etoro-snapshots', etoroStores.snapshots, { clock }),
    reconciliations: await AppendOnlyLog.open<EtoroReconciliationRecord>('etoro-reconciliations', etoroStores.reconciliations, { clock }),
    syncs,
    clock,
  });
  holder.etoro = etoro;
  return {
    f,
    etoro,
    syncs,
    sync: async (kind) => {
      portfolio.response = { status: 200, body: portfolioBody(kind) };
      return (await etoro.sync()).snapshot.snapshotId;
    },
    attest: (openIntentId, snapshotId, overrides = {}, by = HUMAN) =>
      f.service.attestExternalClosure(openIntentId, { positionId: POSITION, snapshotId, statement: EXTERNAL_CLOSURE_STATEMENT, ...overrides }, by as typeof HUMAN),
  };
}

/**
 * The O22 history as it should have been recorded: the open is FILLED by a checked status read naming the position, a snapshot
 * shows the position, and a later snapshot no longer shows it (closed by hand). Returns the open and the snapshot without it.
 */
export async function filledThenClosedByHand(p: ClosureProcess): Promise<{ open: string; closedSnapshot: string }> {
  const open = await filledOpen(p.f, POSITION);
  p.f.advance(10_000);
  await p.sync('with_position');
  p.f.advance(60_000);
  const closedSnapshot = await p.sync('without_position');
  return { open, closedSnapshot };
}
