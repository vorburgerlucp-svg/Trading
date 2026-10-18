// The single composition path of the runtime. The production entry point (PostgreSQL stores) and the smoke test (in-memory
// stores) both call composeRuntime, so the code that is tested is the code that runs.

import type { AppendOnlyStore } from '../persistence/append-only-log.js';
import { InstrumentRegistry, type InstrumentEvent } from '../market-data/instrument-registry.js';
import { MarketDataService } from '../market-data/market-data-service.js';
import type { MarketDataProvider } from '../market-data/market-data-provider.js';
import type { MarketDataStore } from '../market-data/market-data-store.js';
import { QuantService } from '../quant/quant-service.js';
import type { QuantRunStore } from '../quant/quant-run-store.js';
import { PortfolioKillSwitchStore } from '../safety/portfolio-kill-switch-store.js';
import type { KillSwitchState } from '../safety/portfolio-safety-envelope.js';
import { createRuntimeServices, type MarketDataMode } from './services.js';
import type { RuntimeServices } from './app.js';
import type { AppendOnlyLog } from '../persistence/append-only-log.js';
import type { EtoroReconciliationRecord, EtoroSnapshotRecord, EtoroSyncRecord, EtoroLedgerView } from '../broker/etoro/etoro-broker-service.js';
import { EtoroBrokerService } from '../broker/etoro/etoro-broker-service.js';
import { EtoroBrokerSyncAdapter } from '../broker/etoro/etoro-sync-adapter.js';
import type { EtoroTransport } from '../broker/etoro/etoro-transport.js';
import { EToroDemoExecutionAdapter } from '../broker/etoro/execution/etoro-demo-execution-adapter.js';
import type { DemoExecutionTransport } from '../broker/etoro/execution/etoro-demo-execution-transport.js';
import {
  EtoroDemoExecutionService,
  type AttemptRecord,
  type ConfirmationRecord,
  type DemoQuoteSource,
  type DemoSafetySource,
  type IntentEvent,
  type ReconciliationRecord,
} from '../broker/etoro/execution/etoro-demo-execution-service.js';
import { DEMO_E2E_CYCLE_POLICY } from '../broker/etoro/execution/execution-gate.js';
import { NO_DEMO_SAFETY_SOURCE, storedQuoteSource } from './demo-execution-sources.js';

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
  /** The eToro demo read-only wiring (O20). Absent when ETORO_ENABLED is 0: the broker then reports not connected. */
  etoro?: {
    transport: EtoroTransport;
    ledger: EtoroLedgerView;
    snapshots: AppendOnlyLog<EtoroSnapshotRecord>;
    reconciliations: AppendOnlyLog<EtoroReconciliationRecord>;
    syncs: AppendOnlyLog<EtoroSyncRecord>;
  };
  /**
   * The eToro demo execution wiring (O21). Present only when ETORO_DEMO_EXECUTION_ENABLED=1. The build lock is never passed: the
   * service always uses BUILD_LOCKS.etoroDemoExecution.
   */
  etoroDemoExecution?: {
    transport: DemoExecutionTransport;
    intents: AppendOnlyLog<IntentEvent>;
    attempts: AppendOnlyLog<AttemptRecord>;
    confirmations: AppendOnlyLog<ConfirmationRecord>;
    reconciliations: AppendOnlyLog<ReconciliationRecord>;
    /** TESTS ONLY. The entry point never passes them: the runtime has no eToro demo safety source, and quotes come from the store. */
    safetyForTests?: DemoSafetySource;
    quotesForTests?: DemoQuoteSource;
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
  const etoro = input.etoro
    ? new EtoroBrokerService({
        adapter: new EtoroBrokerSyncAdapter({ transport: input.etoro.transport, clock }),
        ledger: input.etoro.ledger,
        snapshots: input.etoro.snapshots,
        reconciliations: input.etoro.reconciliations,
        syncs: input.etoro.syncs,
        clock,
        // The human-governed etoro mapping maps eToro positions to NEXUS instruments; nothing is registered automatically.
        instruments: registry,
      })
    : null;
  const executionInput = input.etoroDemoExecution;
  const demoExecution = executionInput
    ? new EtoroDemoExecutionService({
        adapter: new EToroDemoExecutionAdapter({ transport: executionInput.transport, clock }),
        intents: executionInput.intents,
        attempts: executionInput.attempts,
        confirmations: executionInput.confirmations,
        reconciliations: executionInput.reconciliations,
        registry,
        killSwitch,
        safety: executionInput.safetyForTests ?? NO_DEMO_SAFETY_SOURCE,
        quotes: executionInput.quotesForTests ?? storedQuoteSource(input.marketData, input.marketDataMode),
        brokerStatus: () => {
          if (etoro === null) return { connection: 'not_connected', lastSuccessfulSync: null };
          const status = etoro.status().etoro;
          return { connection: status.connection, lastSuccessfulSync: status.lastSuccessfulSync };
        },
        executionEnabled: true,
        // O22: the runtime runs the one controlled demo cycle only: one open and one close submission over the whole intent log,
        // at most 100 USD at leverage 1. Stricter than the O21 default in every field; a code constant, never configuration.
        policy: DEMO_E2E_CYCLE_POLICY,
        clock,
      })
    : null;
  return createRuntimeServices({
    etoroDemoExecution: demoExecution,
    registry,
    marketData,
    quant,
    killSwitch,
    provider: input.provider,
    marketDataMode: input.marketDataMode,
    ping: input.ping,
    version: input.version,
    etoro,
    ...(input.clock ? { clock: input.clock } : {}),
  });
}
