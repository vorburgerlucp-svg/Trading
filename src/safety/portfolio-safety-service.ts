import { CapitalEngine, type SnapshotOptions } from '../capital/capital-engine.js';
import {
  evaluatePortfolioSafetyEnvelope,
  type PortfolioSafetyDecision,
  type PortfolioSafetyPolicy,
} from './portfolio-safety-envelope.js';
import {
  PortfolioKillSwitchStore,
  PortfolioKillSwitchStoreError,
} from './portfolio-kill-switch-store.js';
import { RiskDayTracker } from './risk-day-tracker.js';

/**
 * Safe integration entry point for Phase 4 preparation.
 *
 * It sources the previous kill-switch state from append-only storage and the RiskDaySummary from
 * CapitalEngine-backed checkpoints. Callers provide neither trust-sensitive object directly.
 */
export class PortfolioSafetyService {
  constructor(
    readonly riskDay: RiskDayTracker,
    readonly killSwitch: PortfolioKillSwitchStore,
  ) {}

  async evaluateCurrent(
    engine: CapitalEngine,
    options: SnapshotOptions & { asOf: string },
    policy: PortfolioSafetyPolicy,
  ): Promise<PortfolioSafetyDecision> {
    const portfolio = await this.riskDay.capture(engine, options);
    const day = this.riskDay.summary();

    await this.killSwitch.sync();
    let previous = this.killSwitch.current();
    let decision = evaluatePortfolioSafetyEnvelope({
      portfolio,
      day,
      previousKillSwitch: previous,
      policy,
    });

    if (previous.status === 'ARMED' && decision.killSwitch.status === 'TRIPPED') {
      try {
        await this.killSwitch.latch(decision.killSwitch);
      } catch (error) {
        if (!(error instanceof PortfolioKillSwitchStoreError) || error.code !== 'ALREADY_TRIPPED') throw error;
        await this.killSwitch.sync();
      }
      previous = this.killSwitch.current();
      decision = evaluatePortfolioSafetyEnvelope({
        portfolio,
        day,
        previousKillSwitch: previous,
        policy,
      });
    }

    return decision;
  }
}
