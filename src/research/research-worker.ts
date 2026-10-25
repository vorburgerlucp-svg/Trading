// R1 research worker: one bounded run. It fetches the completed 15-minute bars of the catalog instruments that are not stored
// yet, through the existing MarketDataService (validation, revisions, quarantine, knowledge and vintage labels), and records
// what it did in the versioned run protocol. It has no broker, no strategy, no model call and no outcome evaluation.
//
// Order of one run (every step fails closed):
//   1. free memory below the threshold: skip (recorded), touch nothing else;
//   2. worker lock held by another process: skip (recorded);
//   3. earlier runs that started but never finished are recorded as abandoned (the lock proves they are dead);
//   4. no documented data clearance: nothing is fetched or stored;
//   5. the registry must match the catalog exactly (a missing instrument is registered; a different one stops the run);
//   6. per instrument, within the run deadline and the credit budget: completed bars only, at most maxCatchUp back.
// A repeated run is idempotent: the store keeps identical bars unchanged, and the run protocol has its own ids.

import { randomBytes } from 'node:crypto';
import { InstrumentRegistry, type InstrumentEvent } from '../market-data/instrument-registry.js';
import { MarketDataError, type MarketDataProvider } from '../market-data/market-data-provider.js';
import { MarketDataService } from '../market-data/market-data-service.js';
import type { MarketDataStore } from '../market-data/market-data-store.js';
import { INTERVAL_MS, type BarSession, type Instrument } from '../market-data/market-data-types.js';
import type { FetchLike } from '../market-data/providers/resilience.js';
import { requireCalendar } from '../market-data/sessions.js';
import { toUtcIso } from '../market-data/time.js';
import type { AppendOnlyLog, AppendOnlyStore } from '../persistence/append-only-log.js';
import { hashOf } from '../persistence/canonical-json.js';
import { FinalBarsOnlyProvider } from './final-bars-provider.js';
import { CreditBudget, guardedFetch, ResearchBudgetError } from './research-budget.js';
import { instrumentOf, mappingOf, RESEARCH_ADJUSTMENT, RESEARCH_INTERVAL, RESEARCH_PROVIDER, RESEARCH_SETTLE_MS, researchCatalogFingerprint, type ResearchCatalog, type ResearchCatalogEntry } from './research-catalog.js';
import type { ResearchConfig } from './research-config.js';
import type { WorkerLock, WorkerLockHandle } from './research-lock.js';
import { WorkerLockLostError } from './research-lock.js';
import {
  RESEARCH_RUN_SCHEMA,
  recordsOf,
  researchRunLogName,
  unfinishedRuns,
  type InstrumentFetchResult,
  type ResearchRunLogs,
  type ResearchRunRecord,
  type ResearchRunStatus,
} from './research-run-log.js';

/** Time kept free before the deadline for the final protocol record and the lock release. */
const FINISH_RESERVE_MS = 10_000;
const DAY_MS = 86_400_000;

export const RESEARCH_ACTOR = Object.freeze({ kind: 'system' as const, id: 'nexus-research-r1' });

export type ResearchWorkerSettings = Pick<ResearchConfig, 'budget' | 'maxRunMs' | 'minFreeMemoryMb' | 'maxCatchUpMs' | 'dataClearance' | 'codeVersion'>;

export interface ResearchWorkerDeps {
  catalog: ResearchCatalog;
  settings: ResearchWorkerSettings;
  /** Opens (creating if needed) the run protocol log of the given name. */
  openRunLog: (name: string) => Promise<AppendOnlyLog<ResearchRunRecord>>;
  instruments: AppendOnlyStore<InstrumentEvent>;
  marketData: MarketDataStore;
  lock: WorkerLock;
  /** The provider, built around the guarded fetch it is given. The worker never hands it any other fetch. */
  providerWith: (fetch: FetchLike) => MarketDataProvider;
  /** The raw transport; it is only ever called through guardedFetch. */
  fetch: FetchLike;
  /** The source id the provider stores its bars under (e.g. twelvedata:time_series:production). */
  sourceId: string;
  clock?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** Free physical memory in MB. */
  freeMemoryMb: () => number;
  newRunId?: () => string;
}

export type ResearchRunOutcome =
  | { kind: 'skipped'; runId: string; reason: 'LOCK_HELD' | 'LOW_MEMORY' }
  | { kind: 'finished'; runId: string; status: ResearchRunStatus; instruments: InstrumentFetchResult[]; creditsUsed: number; abandonedRuns: string[] };

class CatalogMismatchError extends Error {
  override readonly name = 'CatalogMismatchError';
}

function defaultRunId(now: Date): string {
  return 'rr_' + now.toISOString().replace(/[-:.]/g, '').slice(0, 15) + '_' + randomBytes(4).toString('hex');
}

/** A fingerprint of the settings that shape what a run fetches (budget, limits); the clearance text is recorded separately. */
export function settingsFingerprint(settings: ResearchWorkerSettings): string {
  return hashOf({ budget: settings.budget, maxRunMs: settings.maxRunMs, minFreeMemoryMb: settings.minFreeMemoryMb, maxCatchUpMs: settings.maxCatchUpMs });
}

function emptyResult(instrumentId: string, outcome: InstrumentFetchResult['outcome']): InstrumentFetchResult {
  return { instrumentId, outcome, requests: 0, finalBars: 0, droppedInProgress: 0, inserted: 0, unchanged: 0, providerRevisions: 0, quarantined: 0, contemporaneous: 0, historicalReconstruction: 0 };
}

function sessionOf(instrument: Instrument): BarSession {
  return instrument.assetClass === 'crypto' || instrument.assetClass === 'forex' ? 'continuous' : 'regular';
}

/** The registry must hold exactly the catalog's instrument and an open mapping equal to the catalog's. */
async function ensureCatalog(registry: InstrumentRegistry, catalog: ResearchCatalog, at: string): Promise<void> {
  const change = { at, by: RESEARCH_ACTOR, reason: 'research catalog ' + catalog.catalogId + ' (' + catalog.version + ')' };
  for (const entry of catalog.instruments) {
    const expected = instrumentOf(entry);
    const mapping = mappingOf(entry);
    const existing = registry.get(entry.instrumentId);
    if (!existing) {
      const { instrumentId: _id, ...rest } = mapping;
      await registry.registerWithMapping(expected, rest, change);
      continue;
    }
    if (hashOf(existing) !== hashOf(expected)) throw new CatalogMismatchError('instrument ' + entry.instrumentId + ' in the registry differs from the catalog');
    const open = registry.mappings(entry.instrumentId).filter((m) => m.provider === RESEARCH_PROVIDER && m.validTo === undefined);
    if (open.length !== 1 || hashOf(open[0]) !== hashOf(mapping)) throw new CatalogMismatchError('provider mapping of ' + entry.instrumentId + ' differs from the catalog');
  }
}

export async function runResearchOnce(deps: ResearchWorkerDeps): Promise<ResearchRunOutcome> {
  const clock = deps.clock ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const started = clock();
  const startMs = started.getTime();
  const runId = deps.newRunId ? deps.newRunId() : defaultRunId(started);
  const { settings } = deps;
  const logs: ResearchRunLogs = {
    yesterday: await deps.openRunLog(researchRunLogName(startMs - DAY_MS)),
    today: await deps.openRunLog(researchRunLogName(startMs)),
  };
  const log = logs.today;
  const at = () => clock().toISOString();
  const record = (id: string, payload: ResearchRunRecord) => log.append(runId + ':' + id, payload);

  const freeMb = deps.freeMemoryMb();
  if (!(freeMb >= settings.minFreeMemoryMb)) {
    await record('skipped', { schema: RESEARCH_RUN_SCHEMA, kind: 'run_skipped', runId, at: at(), reason: 'LOW_MEMORY', detail: 'free ' + Math.floor(freeMb) + ' MB < ' + settings.minFreeMemoryMb + ' MB' });
    return { kind: 'skipped', runId, reason: 'LOW_MEMORY' };
  }
  const lock: WorkerLockHandle | null = await deps.lock.tryAcquire();
  if (!lock) {
    await record('skipped', { schema: RESEARCH_RUN_SCHEMA, kind: 'run_skipped', runId, at: at(), reason: 'LOCK_HELD' });
    return { kind: 'skipped', runId, reason: 'LOCK_HELD' };
  }

  const instruments: InstrumentFetchResult[] = [];
  const abandonedRuns: string[] = [];
  let status: ResearchRunStatus = 'completed';
  let detail: string | undefined;
  try {
    await logs.yesterday.sync();
    await logs.today.sync();
    // Holding the lock proves that no other run is alive: every unfinished run is dead.
    for (const dead of unfinishedRuns(recordsOf(logs))) {
      await log.append('abandoned:' + dead.runId, { schema: RESEARCH_RUN_SCHEMA, kind: 'run_abandoned', runId, at: at(), abandonedRunId: dead.runId, startedAt: dead.startedAt });
      abandonedRuns.push(dead.runId);
    }
    const startedRecord = await record('started', {
      schema: RESEARCH_RUN_SCHEMA,
      kind: 'run_started',
      runId,
      at: started.toISOString(),
      codeVersion: settings.codeVersion,
      catalogId: deps.catalog.catalogId,
      catalogFingerprint: researchCatalogFingerprint(deps.catalog),
      configFingerprint: settingsFingerprint(settings),
      dataClearance: settings.dataClearance,
    });
    // A run id is used exactly once: an existing start record means another process used the same id, and its credit and
    // protocol records would silently merge with this run's. Fail closed.
    if (startedRecord.status !== 'APPLIED') throw new Error('run id ' + runId + ' was already used');

    if (settings.dataClearance === null) {
      status = 'license_not_cleared';
      detail = 'no documented data clearance (NEXUS_RESEARCH_DATA_CLEARANCE): nothing fetched or stored';
      for (const entry of deps.catalog.instruments) instruments.push(emptyResult(entry.instrumentId, 'skipped'));
    } else {
      const registry = await InstrumentRegistry.open(deps.instruments, { clock });
      try {
        await ensureCatalog(registry, deps.catalog, at());
      } catch (error) {
        if (!(error instanceof CatalogMismatchError)) throw error;
        status = 'catalog_mismatch';
        detail = error.message;
      }
      if (status === 'completed') {
        const deadlineMs = startMs + settings.maxRunMs - FINISH_RESERVE_MS;
        const budget = new CreditBudget({ budget: settings.budget, runId, log, records: () => recordsOf(logs), clock, sleep, deadlineMs });
        const provider = new FinalBarsOnlyProvider(deps.providerWith(guardedFetch(deps.fetch, budget)));
        const service = new MarketDataService({ registry, store: deps.marketData, providers: [provider], clock });
        const pending = [...deps.catalog.instruments];
        while (pending.length > 0) {
          if (clock().getTime() >= deadlineMs) {
            status = 'deadline_reached';
            break;
          }
          await lock.assertHeld();
          const entry = pending.shift()!;
          try {
            instruments.push(await fetchInstrument(entry, { registry, service, provider, deps, clock }));
          } catch (error) {
            if (error instanceof WorkerLockLostError) throw error;
            const result = emptyResult(entry.instrumentId, 'failed');
            result.requests = provider.last.requests;
            if (error instanceof ResearchBudgetError) {
              result.errorCode = error.code;
              instruments.push(result);
              status = 'budget_exhausted';
              break;
            }
            result.errorCode = error instanceof MarketDataError ? 'MARKET_DATA_' + error.code.toUpperCase() : (error as Error).name || 'ERROR';
            instruments.push(result);
          }
        }
        for (const entry of pending) instruments.push(emptyResult(entry.instrumentId, 'skipped'));
      } else {
        for (const entry of deps.catalog.instruments) instruments.push(emptyResult(entry.instrumentId, 'skipped'));
      }
    }
  } catch (error) {
    status = 'failed';
    detail = (error as Error).name + ': ' + (error as Error).message.slice(0, 200);
  }
  const creditsUsed = recordsOf(logs).reduce((sum, r) => sum + (r.kind === 'credit_reserved' && r.runId === runId ? r.credits : 0), 0);
  try {
    await record('finished', { schema: RESEARCH_RUN_SCHEMA, kind: 'run_finished', runId, at: at(), status, instruments, creditsUsed, ...(detail !== undefined ? { detail } : {}) });
  } finally {
    await lock.release();
  }
  return { kind: 'finished', runId, status, instruments, creditsUsed, abandonedRuns };
}

async function fetchInstrument(
  entry: ResearchCatalogEntry,
  ctx: { registry: InstrumentRegistry; service: MarketDataService; provider: FinalBarsOnlyProvider; deps: ResearchWorkerDeps; clock: () => Date },
): Promise<InstrumentFetchResult> {
  const { registry, service, provider, deps } = ctx;
  const instrument = registry.get(entry.instrumentId)!;
  const calendar = requireCalendar(instrument);
  const step = INTERVAL_MS[RESEARCH_INTERVAL];
  const nowMs = ctx.clock().getTime();
  const latestStart = calendar.latestCompletedBarStart(nowMs, RESEARCH_INTERVAL, 'regular', RESEARCH_SETTLE_MS);
  if (latestStart === null) return emptyResult(entry.instrumentId, 'up_to_date');

  const earliestMs = nowMs - deps.settings.maxCatchUpMs;
  const stored = await deps.marketData.readBars({
    instrumentId: entry.instrumentId,
    source: deps.sourceId,
    interval: RESEARCH_INTERVAL,
    session: sessionOf(instrument),
    adjustment: RESEARCH_ADJUSTMENT,
    from: toUtcIso(earliestMs),
    asOf: toUtcIso(nowMs),
    finalOnly: true,
  });
  const last = stored.at(-1);
  let gapBefore: string | undefined;
  let fromMs: number | null;
  if (last) {
    fromMs = calendar.nextBarStart(Date.parse(last.startTime), RESEARCH_INTERVAL, 'regular');
  } else {
    fromMs = calendar.firstBarStartAtOrAfter(earliestMs, RESEARCH_INTERVAL, 'regular');
    // Bars exist, but none within the catch-up window: the time before it stays a recorded gap.
    if (fromMs !== null && (await deps.marketData.head(entry.instrumentId)) > 0) gapBefore = toUtcIso(fromMs);
  }
  if (fromMs === null || fromMs > latestStart) return emptyResult(entry.instrumentId, 'up_to_date');

  const from = toUtcIso(fromMs);
  const to = toUtcIso(latestStart + step);
  const backfill = await service.backfillBars({ instrumentId: entry.instrumentId, provider: RESEARCH_PROVIDER, interval: RESEARCH_INTERVAL, adjustment: RESEARCH_ADJUSTMENT, from, to });
  const summaries = backfill.windows.map((w) => w.summary);
  const counts = provider.last;
  return {
    instrumentId: entry.instrumentId,
    outcome: 'fetched',
    from,
    to,
    requests: backfill.requests,
    finalBars: counts.finalBars,
    droppedInProgress: counts.droppedInProgress,
    inserted: summaries.reduce((s, x) => s + x.inserted, 0),
    unchanged: summaries.reduce((s, x) => s + x.unchanged, 0),
    providerRevisions: summaries.reduce((s, x) => s + x.providerRevisions, 0),
    quarantined: summaries.reduce((s, x) => s + x.quarantined.length, 0),
    contemporaneous: counts.contemporaneous,
    historicalReconstruction: counts.historicalReconstruction,
    ...(gapBefore !== undefined ? { gapBefore } : {}),
  };
}
