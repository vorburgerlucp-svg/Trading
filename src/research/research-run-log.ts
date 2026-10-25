// R1 research run protocol (versioned). One append-only, hash-chained log per UTC day ("research-runs-v1.YYYY-MM-DD"), so a
// process only ever loads two small logs (today and yesterday) however long the instance runs. Records are written BEFORE the
// effect they describe where it matters: a credit is reserved before the request that spends it, so a crash can never hide
// spent credits from the budget.

import type { AppendOnlyLog } from '../persistence/append-only-log.js';

export const RESEARCH_RUN_SCHEMA = 'research-run:v1' as const;
export const RESEARCH_RUN_LOG_PREFIX = 'research-runs-v1.';

export type ResearchSkipReason = 'LOCK_HELD' | 'LOW_MEMORY';

export type ResearchRunStatus =
  /** Every catalog instrument was handled (fetched, up to date, or failed with a recorded error). */
  | 'completed'
  /** The run deadline was reached before every instrument was handled. */
  | 'deadline_reached'
  /** A credit budget (day or minute) refused a request; the remaining instruments were not fetched. */
  | 'budget_exhausted'
  /** No documented data clearance: nothing was fetched or stored. */
  | 'license_not_cleared'
  /** The registry disagrees with the catalog: nothing was fetched (fail closed). */
  | 'catalog_mismatch'
  /** An unexpected error ended the run. */
  | 'failed';

export interface InstrumentFetchResult {
  instrumentId: string;
  /** fetched: bars were requested. up_to_date: no completed bar was missing. failed: the provider or the store refused. skipped: not reached. */
  outcome: 'fetched' | 'up_to_date' | 'failed' | 'skipped';
  from?: string;
  to?: string;
  requests: number;
  /** Final bars returned by the provider and handed to the store. */
  finalBars: number;
  /** In-progress bars the provider returned; never stored by the research instance. */
  droppedInProgress: number;
  inserted: number;
  unchanged: number;
  providerRevisions: number;
  quarantined: number;
  /** Final bars captured within the capture window (live observation). */
  contemporaneous: number;
  /** Final bars fetched later: stored and labelled as historical reconstruction, never as a live observation. */
  historicalReconstruction: number;
  /** A catch-up limited by maxCatchUp left bars before this instant unfetched (a recorded gap). */
  gapBefore?: string;
  errorCode?: string;
}

export type ResearchRunRecord =
  | {
      schema: typeof RESEARCH_RUN_SCHEMA;
      kind: 'run_started';
      runId: string;
      at: string;
      codeVersion: string;
      catalogId: string;
      catalogFingerprint: string;
      configFingerprint: string;
      dataClearance: string | null;
    }
  | { schema: typeof RESEARCH_RUN_SCHEMA; kind: 'credit_reserved'; runId: string; at: string; credits: number; endpoint: string }
  | { schema: typeof RESEARCH_RUN_SCHEMA; kind: 'run_finished'; runId: string; at: string; status: ResearchRunStatus; instruments: InstrumentFetchResult[]; creditsUsed: number; detail?: string }
  | { schema: typeof RESEARCH_RUN_SCHEMA; kind: 'run_skipped'; runId: string; at: string; reason: ResearchSkipReason; detail?: string }
  /** A run that started but never finished (crash, kill, power loss), found by a later run that holds the worker lock. */
  | { schema: typeof RESEARCH_RUN_SCHEMA; kind: 'run_abandoned'; runId: string; at: string; abandonedRunId: string; startedAt: string };

/** The log of the UTC day of `ms`. */
export function researchRunLogName(ms: number): string {
  return RESEARCH_RUN_LOG_PREFIX + new Date(ms).toISOString().slice(0, 10);
}

/** Started runs without a finish, in order. */
export function unfinishedRuns(records: readonly ResearchRunRecord[]): Array<{ runId: string; startedAt: string }> {
  const finished = new Set(records.filter((r) => r.kind === 'run_finished').map((r) => r.runId));
  const abandoned = new Set(records.filter((r) => r.kind === 'run_abandoned').map((r) => (r.kind === 'run_abandoned' ? r.abandonedRunId : '')));
  return records
    .filter((r): r is Extract<ResearchRunRecord, { kind: 'run_started' }> => r.kind === 'run_started')
    .filter((r) => !finished.has(r.runId) && !abandoned.has(r.runId))
    .map((r) => ({ runId: r.runId, startedAt: r.at }));
}

/** Credits reserved within [fromMs, toMs]. Reservations count whether or not their request succeeded. */
export function creditsReservedBetween(records: readonly ResearchRunRecord[], fromMs: number, toMs: number): number {
  let sum = 0;
  for (const r of records) {
    if (r.kind !== 'credit_reserved') continue;
    const at = Date.parse(r.at);
    if (at >= fromMs && at <= toMs) sum += r.credits;
  }
  return sum;
}

/** The two day logs a run needs: yesterday (unfinished runs and the minute window across midnight) and today. */
export interface ResearchRunLogs {
  yesterday: AppendOnlyLog<ResearchRunRecord>;
  today: AppendOnlyLog<ResearchRunRecord>;
}

export function recordsOf(logs: ResearchRunLogs): ResearchRunRecord[] {
  return [...logs.yesterday.all(), ...logs.today.all()].map((r) => r.payload);
}
