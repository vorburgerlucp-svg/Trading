import type { SnapshotOptions } from '../capital/capital-engine.js';
import { CapitalEngine } from '../capital/capital-engine.js';
import type { PortfolioSnapshot } from '../capital/capital-types.js';
import { rappen, sumChf, type Rappen } from '../money/money.js';
import {
  AppendOnlyLog,
  InMemoryAppendOnlyStore,
  type AppendOnlyStore,
} from '../persistence/append-only-log.js';
import { hashOf } from '../persistence/canonical-json.js';
import {
  RISK_DAY_SUMMARY_VERSION,
  type RiskDaySummary,
} from './portfolio-safety-envelope.js';

export const RISK_DAY_CHECKPOINT_VERSION = 'risk-day-checkpoint:v1' as const;

export interface RiskDayCheckpoint {
  version: typeof RISK_DAY_CHECKPOINT_VERSION;
  dayId: string;
  dayStartedAt: string;
  asOf: string;
  totalNetWorthChf: Rappen;
  netContributionsChf: Rappen;
  realizedTradingPnlCumulativeChf: Rappen;
  ledgerHeadHash: string;
  portfolioFingerprint: string;
}

export class RiskDayTrackerError extends Error {
  override readonly name = 'RiskDayTrackerError';
  constructor(readonly code: 'INVALID_DAY' | 'INVALID_CAPTURE' | 'NO_CHECKPOINTS', message: string) {
    super(code + ': ' + message);
  }
}

function canonicalMs(value: string): number | null {
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value ? ms : null;
}

function dayIdOf(iso: string): string {
  return iso.slice(0, 10);
}

function cumulativeTradingPnl(portfolio: PortfolioSnapshot): Rappen {
  return sumChf(portfolio.positions.map((position) => position.realizedPnlChf));
}

/**
 * Append-only producer for RiskDaySummary. Economic fields are derived from CapitalEngine snapshots
 * and the ledger head; callers never provide external-flow, realized-P&L or peak values directly.
 */
export class RiskDayTracker {
  private constructor(
    readonly dayStartedAt: string,
    readonly dayId: string,
    private readonly log: AppendOnlyLog<RiskDayCheckpoint>,
  ) {}

  static async open(
    dayStartedAt: string,
    store: AppendOnlyStore<RiskDayCheckpoint> = new InMemoryAppendOnlyStore<RiskDayCheckpoint>(),
  ): Promise<RiskDayTracker> {
    const startMs = canonicalMs(dayStartedAt);
    if (startMs === null) throw new RiskDayTrackerError('INVALID_DAY', 'dayStartedAt must be canonical UTC');
    const dayId = dayIdOf(dayStartedAt);
    const tracker = new RiskDayTracker(
      dayStartedAt,
      dayId,
      await AppendOnlyLog.open<RiskDayCheckpoint>('portfolio-risk-day:' + dayId, store),
    );
    tracker.validateHistory();
    return tracker;
  }

  async capture(
    engine: CapitalEngine,
    options: SnapshotOptions & { asOf: string },
  ): Promise<PortfolioSnapshot> {
    const asOfMs = canonicalMs(options.asOf);
    const startMs = canonicalMs(this.dayStartedAt)!;
    if (asOfMs === null || asOfMs < startMs || dayIdOf(options.asOf) !== this.dayId) {
      throw new RiskDayTrackerError('INVALID_CAPTURE', 'capture asOf must be canonical and inside the configured UTC risk day');
    }

    const portfolio = engine.snapshot(options);
    const head = engine.ledger.head();
    const checkpoint: RiskDayCheckpoint = {
      version: RISK_DAY_CHECKPOINT_VERSION,
      dayId: this.dayId,
      dayStartedAt: this.dayStartedAt,
      asOf: options.asOf,
      totalNetWorthChf: portfolio.capital.totalNetWorthChf,
      netContributionsChf: portfolio.capital.netContributionsChf,
      realizedTradingPnlCumulativeChf: cumulativeTradingPnl(portfolio),
      ledgerHeadHash: head.hash,
      portfolioFingerprint: hashOf(portfolio),
    };
    const checkpointFingerprint = hashOf(checkpoint);
    const id = 'rdc_' + checkpointFingerprint.slice(0, 40);

    await this.log.append(id, checkpoint, {
      precondition: () => {
        const records = this.log.all();
        const last = records.at(-1)?.payload;
        if (!last) {
          if (checkpoint.asOf !== this.dayStartedAt) {
            throw new RiskDayTrackerError('INVALID_CAPTURE', 'first checkpoint must be exactly at dayStartedAt');
          }
          return;
        }
        if (checkpoint.asOf <= last.asOf) {
          throw new RiskDayTrackerError('INVALID_CAPTURE', 'checkpoint time must increase strictly after the first capture');
        }
      },
    });
    return portfolio;
  }

  summary(): RiskDaySummary {
    const records = this.log.all();
    const first = records[0]?.payload;
    const last = records.at(-1)?.payload;
    if (!first || !last) throw new RiskDayTrackerError('NO_CHECKPOINTS', 'risk day has no checkpoints');
    if (first.asOf !== this.dayStartedAt) {
      throw new RiskDayTrackerError('INVALID_DAY', 'risk-day history does not start at dayStartedAt');
    }

    const externalFlows = rappen(last.netContributionsChf - first.netContributionsChf);
    let peakAdjusted = first.totalNetWorthChf;
    for (const record of records) {
      const checkpoint = record.payload;
      const flowSinceStart = checkpoint.netContributionsChf - first.netContributionsChf;
      const adjusted = rappen(checkpoint.totalNetWorthChf - flowSinceStart);
      if (adjusted > peakAdjusted) peakAdjusted = adjusted;
    }

    return {
      version: RISK_DAY_SUMMARY_VERSION,
      dayId: this.dayId,
      dayStartedAt: this.dayStartedAt,
      asOf: last.asOf,
      startNetWorthChf: first.totalNetWorthChf,
      peakAdjustedNetWorthChf: peakAdjusted,
      netExternalFlowsTodayChf: externalFlows,
      realizedTradingPnlTodayChf: rappen(
        last.realizedTradingPnlCumulativeChf - first.realizedTradingPnlCumulativeChf,
      ),
      sourceLedgerHeadHash: last.ledgerHeadHash,
      sourceFingerprint: hashOf({
        tracker: RISK_DAY_CHECKPOINT_VERSION,
        logHeadHash: this.log.headHash,
        checkpointHashes: records.map((record) => record.hash),
      }),
    };
  }

  checkpoints(): readonly RiskDayCheckpoint[] {
    return this.log.all().map((record) => record.payload);
  }

  sync(): Promise<void> {
    return this.log.sync().then(() => this.validateHistory());
  }

  private validateHistory(): void {
    const records = this.log.all();
    let previousAsOf: string | null = null;
    for (const [index, record] of records.entries()) {
      const checkpoint = record.payload;
      if (
        checkpoint.version !== RISK_DAY_CHECKPOINT_VERSION ||
        checkpoint.dayId !== this.dayId ||
        checkpoint.dayStartedAt !== this.dayStartedAt ||
        canonicalMs(checkpoint.asOf) === null ||
        dayIdOf(checkpoint.asOf) !== this.dayId ||
        typeof checkpoint.totalNetWorthChf !== 'bigint' ||
        typeof checkpoint.netContributionsChf !== 'bigint' ||
        typeof checkpoint.realizedTradingPnlCumulativeChf !== 'bigint' ||
        !/^[0-9a-f]{64}$/.test(checkpoint.ledgerHeadHash) ||
        !/^[0-9a-f]{64}$/.test(checkpoint.portfolioFingerprint)
      ) {
        throw new RiskDayTrackerError('INVALID_DAY', 'stored risk-day checkpoint is malformed');
      }
      if (index === 0 && checkpoint.asOf !== this.dayStartedAt) {
        throw new RiskDayTrackerError('INVALID_DAY', 'stored risk-day history does not begin at dayStartedAt');
      }
      if (previousAsOf !== null && checkpoint.asOf <= previousAsOf) {
        throw new RiskDayTrackerError('INVALID_DAY', 'stored risk-day checkpoint times are not strictly increasing');
      }
      previousAsOf = checkpoint.asOf;
    }
  }
}
