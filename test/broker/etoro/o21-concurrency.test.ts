// O21 cross-intent and cross-process concurrency: two EtoroDemoExecutionService instances, each with its own AppendOnlyLog
// instances, on the same underlying stores (like two NEXUS processes on one database). The races are forced deterministically: a
// hold point in the quote read of the execute gate keeps a gate waiting until the other process has acted, so both gates pass
// against the same old book. Only the atomic reservation step (the SUBMITTING precondition inside writeExclusive, after catching
// up with the other process) decides, and exactly the allowed number of broker writes is sent.
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_DEMO_EXECUTION_POLICY, type DemoExecutionPolicy, type GateQuote } from '../../../src/broker/etoro/execution/execution-gate.js';
import { DemoExecutionError } from '../../../src/broker/etoro/execution/etoro-demo-execution-errors.js';
import { CREATOR, ETORO_MSFT_ID, HUMAN, MSFT, ScriptedBroker, freshQuote, inMemoryStores, lookupAnswer, o21Fixture, openInput, orderAccepted, type Fixture, type O21Stores, type Scripted } from './o21-fixture.js';

// TEST ONLY: the write path needs the compile-time lock open for this module (see o21-build-lock.test.ts for the locked build).
vi.mock('../../../src/nexus/safety.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/nexus/safety.js')>();
  return { ...actual, BUILD_LOCKS: Object.freeze({ ...actual.BUILD_LOCKS, etoroDemoExecution: false }) };
});

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** A hold point in a process's quote read. Off by default; when armed, a gate waits there until released. */
class HoldPoint {
  private hold: Promise<void> | null = null;
  private releaseHold: (() => void) | null = null;
  private reachedSignal = deferred();

  arm(): void {
    const d = deferred();
    this.hold = d.promise;
    this.releaseHold = () => d.resolve();
    this.reachedSignal = deferred();
  }

  get reached(): Promise<void> {
    return this.reachedSignal.promise;
  }

  release(): void {
    this.releaseHold?.();
  }

  readonly source = async (): Promise<GateQuote | null> => {
    if (this.hold) {
      this.reachedSignal.resolve();
      await this.hold;
    }
    return freshQuote();
  };
}

interface Processes {
  a: Fixture;
  b: Fixture;
  holdA: HoldPoint;
  holdB: HoldPoint;
  broker: ScriptedBroker;
  stores: O21Stores;
}

async function processes(policy: DemoExecutionPolicy = DEFAULT_DEMO_EXECUTION_POLICY): Promise<Processes> {
  const stores = inMemoryStores();
  const broker = new ScriptedBroker();
  const holdA = new HoldPoint();
  const holdB = new HoldPoint();
  const a = await o21Fixture({ stores, sharedBroker: broker, policy, quoteSource: holdA.source });
  const b = await o21Fixture({ stores, sharedBroker: broker, policy, quoteSource: holdB.source });
  return { a, b, holdA, holdB, broker, stores };
}

async function approved(f: Fixture, overrides: Record<string, unknown>): Promise<string> {
  const created = await f.service.create(openInput(overrides), CREATOR);
  expect(created.state, created.gateReasons.join(',')).toBe('RISK_APPROVED');
  await f.service.approve(created.intentId, HUMAN);
  return created.intentId;
}

async function refusal(promise: Promise<unknown>): Promise<{ code: string; reasons: readonly string[] }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DemoExecutionError) return { code: error.code, reasons: error.reasons };
    throw error;
  }
  throw new Error('expected a refusal');
}

const MSFT_OPEN = { instrumentId: MSFT.instrumentId, etoroInstrumentId: ETORO_MSFT_ID };

async function submittingCount(f: Fixture): Promise<number> {
  await f.intents.sync();
  return f.intents.all().filter((r) => r.payload.state === 'SUBMITTING').length;
}

/**
 * Process B's gate reads its quote and waits (its book is the one before A acts); A executes to the end; then B's gate goes on
 * with that stale book and reaches the reservation step.
 */
async function staleRace(p: Processes, first: string, second: string, firstAnswer: Scripted | ReturnType<typeof orderAccepted> = orderAccepted()) {
  p.holdB.arm();
  const late = p.b.service.execute(second, HUMAN);
  await p.holdB.reached;
  p.broker.next(firstAnswer);
  const early = await p.a.service.execute(first, HUMAN);
  p.holdB.release();
  return { early, late: await refusal(late) };
}

describe('O21 concurrency: cross-intent reservation across two processes', () => {
  it('A. two different approved opens of the same instrument, executed at once: exactly 1 write, one SUBMITTING', async () => {
    const p = await processes();
    const x = await approved(p.a, { strategyRunId: 'run-x' });
    const y = await approved(p.b, { strategyRunId: 'run-y', createdAt: '2026-10-16T13:59:30.000Z' });
    p.holdA.arm();
    p.holdB.arm();
    p.broker.next(orderAccepted(), orderAccepted());
    const both = [p.a.service.execute(x, HUMAN), p.b.service.execute(y, HUMAN)];
    await Promise.all([p.holdA.reached, p.holdB.reached]);
    p.holdA.release();
    p.holdB.release();
    const results = await Promise.allSettled(both);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(DemoExecutionError);
    expect((rejected.reason as DemoExecutionError).code).toBe('GATE_REFUSED');
    expect(p.broker.writes).toHaveLength(1);
    expect(await submittingCount(p.a)).toBe(1);
  });

  it('A (stale book). the second gate passed against the old book; the reservation refuses it', async () => {
    const p = await processes();
    const x = await approved(p.a, { strategyRunId: 'run-x' });
    const y = await approved(p.b, { strategyRunId: 'run-y', createdAt: '2026-10-16T13:59:30.000Z' });
    const { early, late } = await staleRace(p, x, y);
    expect(early.state).toBe('SUBMITTED');
    expect(late.code).toBe('GATE_REFUSED');
    expect(late.reasons).toContain('INSTRUMENT_HAS_LIVE_POSITION_OR_ORDER');
    expect(p.broker.writes).toHaveLength(1);
    expect((await p.b.service.get(y)).state).toBe('APPROVED');
    expect(await submittingCount(p.b)).toBe(1);
  });

  it('B. two instruments, each under the gross exposure limit and together above it: only one is reserved and sent', async () => {
    const p = await processes({ ...DEFAULT_DEMO_EXECUTION_POLICY, maxGrossExposureUsd: '1500' });
    const x = await approved(p.a, { amount: '1000' });
    const y = await approved(p.b, { ...MSFT_OPEN, amount: '1000' });
    const { early, late } = await staleRace(p, x, y);
    expect(early.state).toBe('SUBMITTED');
    expect(late.code).toBe('GATE_REFUSED');
    expect(late.reasons).toContain('GROSS_EXPOSURE_ABOVE_LIMIT');
    expect(late.reasons).not.toContain('AMBIGUOUS_INTENT_UNRESOLVED');
    expect(p.broker.writes).toHaveLength(1);
  });

  it('B (at once). the same pair executed at the same moment: exactly 1 write', async () => {
    const p = await processes({ ...DEFAULT_DEMO_EXECUTION_POLICY, maxGrossExposureUsd: '1500' });
    const x = await approved(p.a, { amount: '1000' });
    const y = await approved(p.b, { ...MSFT_OPEN, amount: '1000' });
    p.holdA.arm();
    p.holdB.arm();
    p.broker.next(orderAccepted(), orderAccepted());
    const both = [p.a.service.execute(x, HUMAN), p.b.service.execute(y, HUMAN)];
    await Promise.all([p.holdA.reached, p.holdB.reached]);
    p.holdA.release();
    p.holdB.release();
    const results = await Promise.allSettled(both);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(p.broker.writes).toHaveLength(1);
  });

  it('C. maxOpenPositions = 1: two different intents cannot both be submitted', async () => {
    const p = await processes({ ...DEFAULT_DEMO_EXECUTION_POLICY, maxOpenPositions: 1 });
    const x = await approved(p.a, {});
    const y = await approved(p.b, { ...MSFT_OPEN });
    const { early, late } = await staleRace(p, x, y);
    expect(early.state).toBe('SUBMITTED');
    expect(late.reasons).toContain('OPEN_POSITIONS_ABOVE_LIMIT');
    expect(p.broker.writes).toHaveLength(1);
  });

  it('C (filled). a filled position still counts: the next open is refused by the reservation', async () => {
    const p = await processes({ ...DEFAULT_DEMO_EXECUTION_POLICY, maxOpenPositions: 1 });
    const x = await approved(p.a, {});
    const y = await approved(p.b, { ...MSFT_OPEN });
    p.holdB.arm();
    const late = p.b.service.execute(y, HUMAN);
    await p.holdB.reached;
    p.broker.next(orderAccepted(), lookupAnswer(3, { positionIds: [77] }));
    await p.a.service.execute(x, HUMAN);
    expect((await p.a.service.refresh(x)).state).toBe('FILLED');
    p.holdB.release();
    expect((await refusal(late)).reasons).toContain('OPEN_POSITIONS_ABOVE_LIMIT');
    expect(p.broker.writes).toHaveLength(1);
  });

  it('D. while process A holds a SUBMITTING reservation (its write has no answer yet), process B reserves no new risk increase', async () => {
    const p = await processes();
    const x = await approved(p.a, {});
    const y = await approved(p.b, { ...MSFT_OPEN });
    const answer = deferred<Scripted>();
    p.broker.next(() => answer.promise);
    const pending = p.a.service.execute(x, HUMAN);
    // Wait until A's write is on the wire: A is SUBMITTING.
    while (p.broker.writes.length === 0) await new Promise((r) => setTimeout(r, 1));
    const refused = await refusal(p.b.service.execute(y, HUMAN));
    expect(refused.reasons).toContain('AMBIGUOUS_INTENT_UNRESOLVED');
    answer.resolve({ throws: 'timeout' });
    expect((await pending).state).toBe('AMBIGUOUS');
    // A is now AMBIGUOUS: still no new risk increase from B.
    expect((await refusal(p.b.service.execute(y, HUMAN))).reasons).toContain('AMBIGUOUS_INTENT_UNRESOLVED');
    expect(p.broker.writes).toHaveLength(1);
  });

  it('D (stale book). B passed its gate before A reserved; A is SUBMITTING when B reaches the reservation: refused', async () => {
    const p = await processes();
    const x = await approved(p.a, {});
    const y = await approved(p.b, { ...MSFT_OPEN });
    const answer = deferred<Scripted>();
    p.holdB.arm();
    const late = p.b.service.execute(y, HUMAN);
    await p.holdB.reached;
    p.broker.next(() => answer.promise);
    const pending = p.a.service.execute(x, HUMAN);
    while (p.broker.writes.length === 0) await new Promise((r) => setTimeout(r, 1));
    p.holdB.release();
    expect((await refusal(late)).reasons).toContain('AMBIGUOUS_INTENT_UNRESOLVED');
    answer.resolve({ throws: 'network' });
    await pending;
    expect(p.broker.writes).toHaveLength(1);
  });

  it('E. the same intent executed by two processes at once: exactly 1 write', async () => {
    const p = await processes();
    const x = await approved(p.a, {});
    p.holdA.arm();
    p.holdB.arm();
    p.broker.next(orderAccepted(), orderAccepted());
    const both = [p.a.service.execute(x, HUMAN), p.b.service.execute(x, HUMAN)];
    await Promise.all([p.holdA.reached, p.holdB.reached]);
    p.holdA.release();
    p.holdB.release();
    const results = await Promise.allSettled(both);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(p.broker.writes).toHaveLength(1);
    expect(await submittingCount(p.a)).toBe(1);
  });

  it('a duplicate created in another process is refused by the reservation as well', async () => {
    const p = await processes();
    const x = await approved(p.a, {});
    // The same trade, created in B before B saw A's intent (B's log is behind): both exist, only one may be sent.
    const created = await p.b.service.create(openInput({ createdAt: '2026-10-16T13:59:30.000Z' }), CREATOR).catch((e: unknown) => e);
    // B syncs before create, so it sees A's intent and refuses the duplicate at creation already.
    expect(created).toBeInstanceOf(DemoExecutionError);
    expect((created as DemoExecutionError).code).toBe('INTENT_DUPLICATE');
    p.broker.next(orderAccepted());
    await p.a.service.execute(x, HUMAN);
    expect(p.broker.writes).toHaveLength(1);
  });
});
