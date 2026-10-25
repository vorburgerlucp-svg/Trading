// R1 research status: a read-only summary of the research instance (runs, budget, coverage of the catalog instruments). It
// reads the run protocol and the stored bars and writes nothing; the CLI opens the database with default_transaction_read_only
// and read-only stores, so PostgreSQL itself refuses any write.

import type { MarketDataStore } from '../market-data/market-data-store.js';
import type { BarSession } from '../market-data/market-data-types.js';
import { requireCalendar } from '../market-data/sessions.js';
import { toUtcIso } from '../market-data/time.js';
import type { ResearchBudget } from './research-config.js';
import { instrumentOf, RESEARCH_ADJUSTMENT, RESEARCH_INTERVAL, RESEARCH_SETTLE_MS, type ResearchCatalog } from './research-catalog.js';
import { creditsReservedBetween, unfinishedRuns, type ResearchRunRecord, type ResearchRunStatus } from './research-run-log.js';

export const RESEARCH_STATUS_VERSION = 'research-status:v1' as const;
const DAY_MS = 86_400_000;
const MAX_EXPECTED = 200;

export interface ResearchInstrumentStatus {
  instrumentId: string;
  latestBarStart: string | null;
  /** Final bars of the last 24 hours, by vintage. */
  barsLast24h: number;
  contemporaneousLast24h: number;
  historicalReconstructionLast24h: number;
  /** Expected bar starts of the last 24 hours (exchange calendar) that are not stored. */
  missingLast24h: number;
  missingStartsSample: string[];
}

export interface ResearchStatus {
  version: typeof RESEARCH_STATUS_VERSION;
  asOf: string;
  lastRun: { runId: string; startedAt: string; status: ResearchRunStatus | 'unfinished'; creditsUsed: number | null } | null;
  runsLast24h: Partial<Record<ResearchRunStatus, number>>;
  skippedLast24h: Partial<Record<'LOCK_HELD' | 'LOW_MEMORY', number>>;
  abandonedLast24h: number;
  /** Started runs without a finish and not yet recorded as abandoned (alive now, or dead and not yet found). */
  unfinished: string[];
  credits: { today: number; lastMinute: number; dailyLimit: number; minuteLimit: number };
  instruments: ResearchInstrumentStatus[];
}

export function summarizeRuns(records: readonly ResearchRunRecord[], nowMs: number, budget: ResearchBudget): Omit<ResearchStatus, 'version' | 'asOf' | 'instruments'> {
  const since = nowMs - DAY_MS;
  const recent = records.filter((r) => Date.parse(r.at) >= since);
  const runsLast24h: ResearchStatus['runsLast24h'] = {};
  const skippedLast24h: ResearchStatus['skippedLast24h'] = {};
  for (const r of recent) {
    if (r.kind === 'run_finished') runsLast24h[r.status] = (runsLast24h[r.status] ?? 0) + 1;
    if (r.kind === 'run_skipped') skippedLast24h[r.reason] = (skippedLast24h[r.reason] ?? 0) + 1;
  }
  const started = records.filter((r): r is Extract<ResearchRunRecord, { kind: 'run_started' }> => r.kind === 'run_started');
  const lastStarted = started.at(-1);
  const finish = lastStarted ? records.find((r): r is Extract<ResearchRunRecord, { kind: 'run_finished' }> => r.kind === 'run_finished' && r.runId === lastStarted.runId) : undefined;
  const dayStart = Date.UTC(new Date(nowMs).getUTCFullYear(), new Date(nowMs).getUTCMonth(), new Date(nowMs).getUTCDate());
  return {
    lastRun: lastStarted ? { runId: lastStarted.runId, startedAt: lastStarted.at, status: finish?.status ?? 'unfinished', creditsUsed: finish?.creditsUsed ?? null } : null,
    runsLast24h,
    skippedLast24h,
    abandonedLast24h: recent.filter((r) => r.kind === 'run_abandoned').length,
    unfinished: unfinishedRuns(records).map((r) => r.runId),
    credits: { today: creditsReservedBetween(records, dayStart, nowMs), lastMinute: creditsReservedBetween(records, nowMs - 60_000 + 1, nowMs), dailyLimit: budget.dailyCredits, minuteLimit: budget.minuteCredits },
  };
}

export async function researchStatus(input: { catalog: ResearchCatalog; records: readonly ResearchRunRecord[]; marketData: MarketDataStore; sourceId: string; budget: ResearchBudget; nowMs: number }): Promise<ResearchStatus> {
  const { nowMs } = input;
  const instruments: ResearchInstrumentStatus[] = [];
  for (const entry of input.catalog.instruments) {
    const instrument = instrumentOf(entry);
    const session: BarSession = instrument.assetClass === 'crypto' ? 'continuous' : 'regular';
    const bars = await input.marketData.readBars({
      instrumentId: entry.instrumentId,
      source: input.sourceId,
      interval: RESEARCH_INTERVAL,
      session,
      adjustment: RESEARCH_ADJUSTMENT,
      from: toUtcIso(nowMs - DAY_MS),
      asOf: toUtcIso(nowMs),
      finalOnly: true,
    });
    const have = new Set(bars.map((b) => Date.parse(b.startTime)));
    const calendar = requireCalendar(instrument);
    const latest = calendar.latestCompletedBarStart(nowMs, RESEARCH_INTERVAL, 'regular', RESEARCH_SETTLE_MS);
    const missing: number[] = [];
    let start = calendar.firstBarStartAtOrAfter(nowMs - DAY_MS, RESEARCH_INTERVAL, 'regular');
    for (let n = 0; start !== null && latest !== null && start <= latest && n < MAX_EXPECTED; n++) {
      if (!have.has(start)) missing.push(start);
      start = calendar.nextBarStart(start, RESEARCH_INTERVAL, 'regular');
    }
    const last = bars.at(-1);
    instruments.push({
      instrumentId: entry.instrumentId,
      latestBarStart: last ? last.startTime : null,
      barsLast24h: bars.length,
      contemporaneousLast24h: bars.filter((b) => b.knowledge.vintage === 'contemporaneous').length,
      historicalReconstructionLast24h: bars.filter((b) => b.knowledge.vintage === 'historical_reconstruction').length,
      missingLast24h: missing.length,
      missingStartsSample: missing.slice(0, 5).map(toUtcIso),
    });
  }
  return { version: RESEARCH_STATUS_VERSION, asOf: toUtcIso(nowMs), ...summarizeRuns(input.records, nowMs, input.budget), instruments };
}
