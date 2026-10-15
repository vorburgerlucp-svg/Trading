// The single composition path of the runtime. The production entry point (PostgreSQL stores) and the smoke test (in-memory
// stores) both call composeRuntime, so the code that is tested is the code that runs.

import type { AppendOnlyStore } from '../persistence/append-only-log.js';
import type { AppendOnlyLog } from '../persistence/append-only-log.js';
import { InstrumentRegistry, type InstrumentEvent } from '../market-data/instrument-registry.js';
import { MarketDataService } from '../market-data/market-data-service.js';
import type { MarketDataProvider } from '../market-data/market-data-provider.js';
import type { MarketDataStore } from '../market-data/market-data-store.js';
import { QuantService } from '../quant/quant-service.js';
import type { QuantRunStore } from '../quant/quant-run-store.js';
import { PortfolioKillSwitchStore } from '../safety/portfolio-kill-switch-store.js';
import type { KillSwitchState } from '../safety/portfolio-safety-envelope.js';
import { IbkrBrokerService, IBKR_PROVIDER, type LedgerView, type ReconciliationRecord, type SnapshotRecord, type SyncRecord } from '../broker/ibkr/ibkr-broker-service.js';
import { IbkrBrokerSyncAdapter } from '../broker/ibkr/ibkr-sync-adapter.js';
import type { IbkrTransport } from '../broker/ibkr/ibkr-transport.js';
import { createRuntimeServices, type MarketDataMode } from './services.js';
import type { RuntimeServices } from './app.js';

export interface ComposeInput {
  instruments: AppendOnlyStore<InstrumentEvent>;
  marketData: MarketDataStore;
  quantRuns: QuantRunStore;
  killSwitch: AppendOnlyStore<KillSwitchState>;
  provider: MarketDataProvider | null;
  marketDataMode: MarketDataMode;
  ping: () => Promise<boolean>;
  version: string;
  clock?: () => Date;
  /** The IBKR read-only wiring. Absent when IBKR is not enabled: the broker then reports not connected. */
  ibkr?: {
    transport: IbkrTransport;
    accountId: string | null;
    accountRef: string | null;
    /** From IBKR_ALLOW_BROKERAGE_INIT. Required: the composition root always states it. */
    allowBrokerageInit: boolean;
    ledger: LedgerView;
    snapshots: AppendOnlyLog<SnapshotRecord>;
    syncs: AppendOnlyLog<SyncRecord>;
    reconciliations: AppendOnlyLog<ReconciliationRecord>;
  };
}

export async function composeRuntime(input: ComposeInput): Promise<RuntimeServices> {
  const registry = await InstrumentRegistry.open(input.instruments, input.clock ? { clock: input.clock } : {});
  const marketData = new MarketDataService({
    registry,
    store: input.marketData,
    providers: input.provider ? [input.provider] : [],
    ...(input.clock ? { clock: input.clock } : {}),
  });
  const quant = new QuantService({
    registry,
    store: input.marketData,
    runs: input.quantRuns,
    ...(input.clock ? { clock: input.clock } : {}),
  });
  const killSwitch = await PortfolioKillSwitchStore.open(input.killSwitch);
  const clock = input.clock ?? (() => new Date());
  const broker = input.ibkr
    ? new IbkrBrokerService({
        adapter: new IbkrBrokerSyncAdapter({
          transport: input.ibkr.transport,
          accountId: input.ibkr.accountId,
          clock,
          resolveInstrument: (brokerInstrumentId, at) => registry.resolve(IBKR_PROVIDER, brokerInstrumentId, at),
          allowBrokerageInit: input.ibkr.allowBrokerageInit,
        }),
        enabled: true,
        accountRef: input.ibkr.accountRef,
        ledger: input.ibkr.ledger,
        registry,
        snapshots: input.ibkr.snapshots,
        syncs: input.ibkr.syncs,
        reconciliations: input.ibkr.reconciliations,
        clock,
      })
    : null;
  return createRuntimeServices({
    registry,
    marketData,
    quant,
    killSwitch,
    provider: input.provider,
    marketDataMode: input.marketDataMode,
    ping: input.ping,
    version: input.version,
    broker,
    ...(input.clock ? { clock: input.clock } : {}),
  });
}
