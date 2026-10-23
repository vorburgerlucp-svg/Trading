// O22 TEST ONLY: fault injection for the append-only stores of the demo execution layer. A FaultStore wraps a real store and
// simulates a process crash at one chosen record: "before" the commit (the record is not stored) or "after" it (the record is
// stored, then the process dies before its next step). The test then drops that service and starts a new one on the same stores
// (a restart), exactly like a second NEXUS process.
import type { AppendOnlyStore, LogRecord, WriteDecision } from '../../../src/persistence/append-only-log.js';
import type { O21Stores } from './o21-fixture.js';

export class InjectedCrash extends Error {
  override readonly name = 'InjectedCrash';
}

export type CrashPoint = 'before' | 'after';

export class FaultStore<T> implements AppendOnlyStore<T> {
  private armed: { match: (payload: T) => boolean; point: CrashPoint } | null = null;
  fired = false;

  constructor(private readonly inner: AppendOnlyStore<T>) {}

  /** Crashes once, at the first appended record whose payload matches. */
  crashAt(match: (payload: T) => boolean, point: CrashPoint): void {
    this.armed = { match, point };
  }

  loadAll(): Promise<readonly LogRecord<T>[]> {
    return this.inner.loadAll();
  }

  loadAfter(sequence: number): Promise<readonly LogRecord<T>[]> {
    return this.inner.loadAfter(sequence);
  }

  async writeExclusive<R>(knownSequence: number, decide: (newer: readonly LogRecord<T>[]) => WriteDecision<T, R>): Promise<R> {
    let hit = false;
    const result = await this.inner.writeExclusive<R>(knownSequence, (newer) => {
      const decision = decide(newer);
      const armed = this.armed;
      if (armed !== null && !this.fired && decision.kind === 'append' && armed.match(decision.record.payload)) {
        this.fired = true;
        this.armed = null;
        // "before": nothing is committed (the store rolls the write back); "after": committed, then the crash.
        if (armed.point === 'before') throw new InjectedCrash('crash before commit');
        hit = true;
      }
      return decision;
    });
    if (hit) throw new InjectedCrash('crash after commit');
    return result;
  }
}

export interface FaultStores {
  stores: O21Stores;
  intents: FaultStore<O21Stores['intents'] extends AppendOnlyStore<infer T> ? T : never>;
  confirmations: FaultStore<O21Stores['confirmations'] extends AppendOnlyStore<infer T> ? T : never>;
  reconciliations: FaultStore<O21Stores['reconciliations'] extends AppendOnlyStore<infer T> ? T : never>;
}

/** The given stores with fault injection on the intent, confirmation and reconciliation logs (attempts are passed through). */
export function withFaults(base: O21Stores): FaultStores {
  const intents = new FaultStore(base.intents);
  const confirmations = new FaultStore(base.confirmations);
  const reconciliations = new FaultStore(base.reconciliations);
  return { stores: { intents, attempts: base.attempts, confirmations, reconciliations }, intents, confirmations, reconciliations };
}

/** O22 Plan B TEST ONLY: opens once `parties` writers have arrived; shared by the stores of several processes. */
export class WriteBarrier {
  private arrived = 0;
  private release!: () => void;
  readonly open = new Promise<void>((resolve) => {
    this.release = resolve;
  });

  constructor(private readonly parties: number) {}

  arrive(): Promise<void> {
    this.arrived += 1;
    if (this.arrived >= this.parties) this.release();
    return this.open;
  }
}

/**
 * O22 Plan B TEST ONLY: holds every write until all parties of the barrier have arrived, then lets them go into the store's own
 * critical section. Processes that all decided on the same stored state then race for the lock, so a test can prove that the check
 * inside the lock, not the order of arrival, decides.
 */
export class BarrierStore<T> implements AppendOnlyStore<T> {
  constructor(private readonly inner: AppendOnlyStore<T>, private readonly barrier: WriteBarrier) {}

  loadAll(): Promise<readonly LogRecord<T>[]> {
    return this.inner.loadAll();
  }

  loadAfter(sequence: number): Promise<readonly LogRecord<T>[]> {
    return this.inner.loadAfter(sequence);
  }

  async writeExclusive<R>(knownSequence: number, decide: (newer: readonly LogRecord<T>[]) => WriteDecision<T, R>): Promise<R> {
    await this.barrier.arrive();
    return this.inner.writeExclusive(knownSequence, decide);
  }
}
