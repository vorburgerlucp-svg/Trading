// R1 credit budget and the guarded fetch of the research instance. Every HTTP request the provider makes goes through
// guardedFetch: it may only reach the Twelve Data time series endpoint, and it reserves one credit in the run log BEFORE the
// request is sent. A refused reservation is a ResearchBudgetError, which the provider's resilience layer does not retry (it is
// not a MarketDataError), so a budget stop ends the request at once.

import type { FetchLike } from '../market-data/providers/resilience.js';
import type { AppendOnlyLog } from '../persistence/append-only-log.js';
import type { ResearchBudget } from './research-config.js';
import { creditsReservedBetween, RESEARCH_RUN_SCHEMA, type ResearchRunRecord } from './research-run-log.js';

export const TWELVE_DATA_ORIGIN = 'https://api.twelvedata.com';
/** The only endpoint of R1, with its credit weight per request (1 credit per symbol for /time_series). */
export const ALLOWED_ENDPOINTS: Readonly<Record<string, number>> = Object.freeze({ '/time_series': 1 });

const MINUTE_MS = 60_000;

export class ResearchBudgetError extends Error {
  override readonly name = 'ResearchBudgetError';
  constructor(
    readonly code: 'DAILY_BUDGET_EXHAUSTED' | 'MINUTE_BUDGET_EXHAUSTED',
    message: string,
  ) {
    super(message);
  }
}

export class ResearchEgressError extends Error {
  override readonly name = 'ResearchEgressError';
}

export interface CreditBudgetDeps {
  budget: ResearchBudget;
  runId: string;
  /** The run's own log (records are written here) and every record the budget must count (both day logs, read at call time). */
  log: AppendOnlyLog<ResearchRunRecord>;
  records: () => readonly ResearchRunRecord[];
  clock: () => Date;
  sleep: (ms: number) => Promise<void>;
  /** The latest instant at which the run may still wait for the minute window. */
  deadlineMs: number;
}

export class CreditBudget {
  private sequence = 0;

  constructor(private readonly deps: CreditBudgetDeps) {}

  /** Credits reserved on the current UTC day (all runs). */
  usedToday(): number {
    const now = this.deps.clock().getTime();
    const dayStart = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());
    return creditsReservedBetween(this.deps.records(), dayStart, now);
  }

  private usedInMinute(now: number): number {
    return creditsReservedBetween(this.deps.records(), now - MINUTE_MS + 1, now);
  }

  /**
   * Reserves `credits` for one request. The day budget refuses at once; the minute budget waits until the window has room, as long
   * as that is before the run deadline, and refuses otherwise.
   */
  async reserve(credits: number, endpoint: string): Promise<void> {
    const { budget } = this.deps;
    if (this.usedToday() + credits > budget.dailyCredits) {
      throw new ResearchBudgetError('DAILY_BUDGET_EXHAUSTED', 'daily credit budget of ' + budget.dailyCredits + ' reached');
    }
    for (;;) {
      const now = this.deps.clock().getTime();
      if (this.usedInMinute(now) + credits <= budget.minuteCredits) break;
      const wait = this.oldestInWindow(now) + MINUTE_MS - now;
      if (now + wait > this.deps.deadlineMs) throw new ResearchBudgetError('MINUTE_BUDGET_EXHAUSTED', 'minute credit budget of ' + budget.minuteCredits + ' reached before the run deadline');
      await this.deps.sleep(Math.max(1, wait));
    }
    const at = this.deps.clock().toISOString();
    // Second line of defense behind the worker lock: the limits are checked again inside the log's critical section, after the
    // records of every other process were applied, so two writers can never both take the last credit.
    const reserved = await this.deps.log.append(
      this.deps.runId + ':credit:' + ++this.sequence,
      { schema: RESEARCH_RUN_SCHEMA, kind: 'credit_reserved', runId: this.deps.runId, at, credits, endpoint },
      {
        precondition: () => {
          const now = Date.parse(at);
          if (this.usedToday() + credits > budget.dailyCredits) throw new ResearchBudgetError('DAILY_BUDGET_EXHAUSTED', 'daily credit budget of ' + budget.dailyCredits + ' reached');
          if (this.usedInMinute(now) + credits > budget.minuteCredits) throw new ResearchBudgetError('MINUTE_BUDGET_EXHAUSTED', 'minute credit budget of ' + budget.minuteCredits + ' reached');
        },
      },
    );
    // A reservation that already existed was another run's (an id collision): it does not pay for this request.
    if (reserved.status !== 'APPLIED') throw new ResearchBudgetError('DAILY_BUDGET_EXHAUSTED', 'credit reservation ' + this.deps.runId + ':credit:' + this.sequence + ' already existed');
  }

  private oldestInWindow(now: number): number {
    let oldest = now;
    for (const r of this.deps.records()) {
      if (r.kind !== 'credit_reserved') continue;
      const at = Date.parse(r.at);
      if (at > now - MINUTE_MS && at < oldest) oldest = at;
    }
    return oldest;
  }
}

/**
 * The fetch the research provider uses. It refuses every origin other than Twelve Data and every path other than the allowed
 * endpoints (before any reservation), then reserves the endpoint's credits, then sends the request.
 */
export function guardedFetch(inner: FetchLike, budget: CreditBudget): FetchLike {
  return async (url, init) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new ResearchEgressError('refused: not a URL');
    }
    if (parsed.origin !== TWELVE_DATA_ORIGIN) throw new ResearchEgressError('refused: the research instance only reaches ' + TWELVE_DATA_ORIGIN);
    const credits = Object.hasOwn(ALLOWED_ENDPOINTS, parsed.pathname) ? ALLOWED_ENDPOINTS[parsed.pathname] : undefined;
    if (credits === undefined || init.method !== 'GET') throw new ResearchEgressError('refused: endpoint ' + parsed.pathname + ' is not allowed for research');
    await budget.reserve(credits, parsed.pathname);
    return inner(url, init);
  };
}
