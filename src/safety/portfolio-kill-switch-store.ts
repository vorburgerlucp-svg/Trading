import {
  AppendOnlyLog,
  InMemoryAppendOnlyStore,
  type AppendOnlyStore,
} from '../persistence/append-only-log.js';
import {
  PORTFOLIO_KILL_SWITCH_VERSION,
  type KillSwitchState,
} from './portfolio-safety-envelope.js';

export class PortfolioKillSwitchStoreError extends Error {
  override readonly name = 'PortfolioKillSwitchStoreError';
  constructor(readonly code: 'INVALID_STATE' | 'ALREADY_TRIPPED', message: string) {
    super(code + ': ' + message);
  }
}

export function armedKillSwitchState(): KillSwitchState {
  return {
    version: PORTFOLIO_KILL_SWITCH_VERSION,
    status: 'ARMED',
    tripId: null,
    trippedAt: null,
    reasons: [],
    triggeringDecisionFingerprint: null,
  };
}

function validateTrip(state: KillSwitchState): void {
  if (
    !state ||
    state.version !== PORTFOLIO_KILL_SWITCH_VERSION ||
    state.status !== 'TRIPPED' ||
    typeof state.tripId !== 'string' ||
    !/^trip_[0-9a-f]{40}$/.test(state.tripId) ||
    typeof state.trippedAt !== 'string' ||
    new Date(state.trippedAt).toISOString() !== state.trippedAt ||
    !Array.isArray(state.reasons) ||
    state.reasons.length === 0 ||
    new Set(state.reasons).size !== state.reasons.length ||
    typeof state.triggeringDecisionFingerprint !== 'string' ||
    !/^[0-9a-f]{64}$/.test(state.triggeringDecisionFingerprint) ||
    state.tripId !== 'trip_' + state.triggeringDecisionFingerprint.slice(0, 40)
  ) {
    throw new PortfolioKillSwitchStoreError('INVALID_STATE', 'kill-switch trip state is invalid');
  }
}

/** Append-only monotonic store. There is deliberately no reset/clear/arm mutation API. */
export class PortfolioKillSwitchStore {
  private constructor(private readonly log: AppendOnlyLog<KillSwitchState>) {}

  static async open(
    store: AppendOnlyStore<KillSwitchState> = new InMemoryAppendOnlyStore<KillSwitchState>(),
  ): Promise<PortfolioKillSwitchStore> {
    const instance = new PortfolioKillSwitchStore(
      await AppendOnlyLog.open<KillSwitchState>('portfolio-kill-switch', store),
    );
    instance.validateHistory();
    return instance;
  }

  current(): KillSwitchState {
    const records = this.log.all();
    const trip = records[0]?.payload;
    return trip ? { ...trip, reasons: [...trip.reasons] } : armedKillSwitchState();
  }

  async latch(state: KillSwitchState): Promise<KillSwitchState> {
    validateTrip(state);
    const result = await this.log.append(state.tripId!, state, {
      precondition: () => {
        if (this.log.all().length > 0) {
          throw new PortfolioKillSwitchStoreError('ALREADY_TRIPPED', 'kill switch is already latched');
        }
      },
    });
    return { ...result.record.payload, reasons: [...result.record.payload.reasons] };
  }

  sync(): Promise<void> {
    return this.log.sync().then(() => this.validateHistory());
  }

  get headHash(): string {
    return this.log.headHash;
  }

  private validateHistory(): void {
    const records = this.log.all();
    if (records.length > 1) {
      throw new PortfolioKillSwitchStoreError('INVALID_STATE', 'kill-switch log contains more than one trip');
    }
    const state = records[0]?.payload;
    if (state) validateTrip(state);
  }
}
