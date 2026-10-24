// O22 TEST ONLY: fault injection for the append-only stores of the demo execution layer. A FaultStore wraps a real store and
// simulates a process crash at one chosen record: "before" the commit (the record is not stored) or "after" it (the record is
// stored, then the process dies before its next step). The test then drops that service and starts a new one on the same stores
// (a restart), exactly like a second NEXUS process.
import type { AppendOnlyStore, GuardRead, LogRecord, WriteDecision } from '../../../src/persistence/append-only-log.js';

type Decide<T, R> = (newer: readonly LogRecord<T>[]) => WriteDecision<T, R>;
type DecideGuarded<T, R, G> = (newer: readonly LogRecord<T>[], guardNewer: readonly LogRecord<G>[]) => WriteDecision<T, R>;

/** Every wrapper passes a guarded write and the storage target through to the wrapped store, with its own hooks around it. */
function guarded<T, R, G>(inner: AppendOnlyStore<T>, knownSequence: number, guard: GuardRead<G>, decide: DecideGuarded<T, R, G>): Promise<R> {
  if (inner.writeExclusiveGuarded === undefined) return Promise.reject(new Error('the wrapped store cannot make a guarded write'));
  return inner.writeExclusiveGuarded<R, G>(knownSequence, guard, decide);
}
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

  writeExclusive<R>(knownSequence: number, decide: Decide<T, R>): Promise<R> {
    return this.crashing<R>((inspect) => this.inner.writeExclusive<R>(knownSequence, (newer) => inspect(decide(newer))));
  }

  writeExclusiveGuarded<R, G>(knownSequence: number, guard: GuardRead<G>, decide: DecideGuarded<T, R, G>): Promise<R> {
    return this.crashing<R>((inspect) => guarded<T, R, G>(this.inner, knownSequence, guard, (newer, guardNewer) => inspect(decide(newer, guardNewer))));
  }

  storageTarget(): AppendOnlyStore<T> {
    return this.inner.storageTarget?.() ?? this.inner;
  }

  private async crashing<R>(invoke: (inspect: (decision: WriteDecision<T, R>) => WriteDecision<T, R>) => Promise<R>): Promise<R> {
    let hit = false;
    const result = await invoke((decision) => {
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

  async writeExclusive<R>(knownSequence: number, decide: Decide<T, R>): Promise<R> {
    await this.barrier.arrive();
    return this.inner.writeExclusive(knownSequence, decide);
  }

  async writeExclusiveGuarded<R, G>(knownSequence: number, guard: GuardRead<G>, decide: DecideGuarded<T, R, G>): Promise<R> {
    await this.barrier.arrive();
    return guarded<T, R, G>(this.inner, knownSequence, guard, decide);
  }

  storageTarget(): AppendOnlyStore<T> {
    return this.inner.storageTarget?.() ?? this.inner;
  }
}

/**
 * O22 Plan B TEST ONLY: holds one process at a chosen point of its writes until the test releases it. "before": the next write waits
 * before it enters the store's critical section (the process has already decided). "after": a write whose record matches waits after
 * it committed (the record is visible to every process; the writer has not taken its next step yet). Holds once.
 */
export class HoldStore<T> implements AppendOnlyStore<T> {
  private armed: { point: CrashPoint; match: (payload: T) => boolean } | null = null;
  private releaseGate!: () => void;
  private reachedGate!: () => void;
  private gate: Promise<void> = Promise.resolve();
  /** Resolves when the held write has arrived at its hold point. */
  reached: Promise<void> = Promise.resolve();

  constructor(private readonly inner: AppendOnlyStore<T>) {}

  hold(point: CrashPoint, match: (payload: T) => boolean = () => true): void {
    this.armed = { point, match };
    this.gate = new Promise<void>((resolve) => (this.releaseGate = resolve));
    this.reached = new Promise<void>((resolve) => (this.reachedGate = resolve));
  }

  release(): void {
    this.releaseGate();
  }

  loadAll(): Promise<readonly LogRecord<T>[]> {
    return this.inner.loadAll();
  }

  loadAfter(sequence: number): Promise<readonly LogRecord<T>[]> {
    return this.inner.loadAfter(sequence);
  }

  writeExclusive<R>(knownSequence: number, decide: Decide<T, R>): Promise<R> {
    return this.holding<R>((inspect) => this.inner.writeExclusive<R>(knownSequence, (newer) => inspect(decide(newer))));
  }

  writeExclusiveGuarded<R, G>(knownSequence: number, guard: GuardRead<G>, decide: DecideGuarded<T, R, G>): Promise<R> {
    return this.holding<R>((inspect) => guarded<T, R, G>(this.inner, knownSequence, guard, (newer, guardNewer) => inspect(decide(newer, guardNewer))));
  }

  storageTarget(): AppendOnlyStore<T> {
    return this.inner.storageTarget?.() ?? this.inner;
  }

  private async holding<R>(invoke: (inspect: (decision: WriteDecision<T, R>) => WriteDecision<T, R>) => Promise<R>): Promise<R> {
    const armed = this.armed;
    if (armed !== null && armed.point === 'before') {
      this.armed = null;
      this.reachedGate();
      await this.gate;
    }
    let matched = false;
    const result = await invoke((decision) => {
      if (armed !== null && armed.point === 'after' && decision.kind === 'append' && armed.match(decision.record.payload)) matched = true;
      return decision;
    });
    if (matched) {
      this.armed = null;
      this.reachedGate();
      await this.gate;
    }
    return result;
  }
}

/**
 * O22 Plan C TEST ONLY: holds one process right AFTER its n-th catch-up read of a log completed (counted from arming): the process has
 * seen the log as it was, and has not used it yet. Used to put another process's write exactly after a read and before its use.
 */
export class ReadHoldStore<T> implements AppendOnlyStore<T> {
  private remaining = 0;
  private releaseGate!: () => void;
  private reachedGate!: () => void;
  private gate: Promise<void> = Promise.resolve();
  reached: Promise<void> = Promise.resolve();

  constructor(readonly inner: AppendOnlyStore<T>) {}

  /** Holds after the n-th loadAfter from now on. */
  holdAfterRead(n: number): void {
    this.remaining = n;
    this.gate = new Promise<void>((resolve) => (this.releaseGate = resolve));
    this.reached = new Promise<void>((resolve) => (this.reachedGate = resolve));
  }

  release(): void {
    this.releaseGate();
  }

  loadAll(): Promise<readonly LogRecord<T>[]> {
    return this.inner.loadAll();
  }

  async loadAfter(sequence: number): Promise<readonly LogRecord<T>[]> {
    const records = await this.inner.loadAfter(sequence);
    if (this.remaining > 0) {
      this.remaining -= 1;
      if (this.remaining === 0) {
        this.reachedGate();
        await this.gate;
      }
    }
    return records;
  }

  writeExclusive<R>(knownSequence: number, decide: Decide<T, R>): Promise<R> {
    return this.inner.writeExclusive(knownSequence, decide);
  }

  writeExclusiveGuarded<R, G>(knownSequence: number, guard: GuardRead<G>, decide: DecideGuarded<T, R, G>): Promise<R> {
    return guarded<T, R, G>(this.inner, knownSequence, guard, decide);
  }

  storageTarget(): AppendOnlyStore<T> {
    return this.inner.storageTarget?.() ?? this.inner;
  }
}
